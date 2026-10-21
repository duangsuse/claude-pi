//! Pure decision logic for the keys interactive mode intercepts. No I/O;
//! main.zig turns these decisions into pty writes / steps.
const std = @import("std");
const screen = @import("screen.zig");

pub const Key = union(enum) {
    tab,
    shift_tab,
    enter,
    ctrl_enter,
    ctrl_c,
    esc,
    up,
    down,
    left,
    right,
    backspace,
    focus_in,
    focus_out,
    char: u21,
    /// SGR mouse report (CC turns on ?1006). x/y are 0-based cells.
    mouse: Mouse,
    other,
};

pub const Mouse = struct { button: u16, x: u16, y: u16, press: bool };

fn decodeMouse(bytes: []const u8) ?Mouse {
    // ESC [ < b ; x ; y (M|m)
    if (bytes.len < 9 or !std.mem.startsWith(u8, bytes, "\x1b[<")) return null;
    const final = bytes[bytes.len - 1];
    if (final != 'M' and final != 'm') return null;
    var it = std.mem.splitScalar(u8, bytes[3 .. bytes.len - 1], ';');
    const b = std.fmt.parseInt(u16, it.next() orelse return null, 10) catch return null;
    const x = std.fmt.parseInt(u16, it.next() orelse return null, 10) catch return null;
    const y = std.fmt.parseInt(u16, it.next() orelse return null, 10) catch return null;
    if (it.next() != null or x == 0 or y == 0) return null;
    return .{ .button = b, .x = x - 1, .y = y - 1, .press = final == 'M' };
}

/// Decode a stdin chunk that is exactly one key. Typing arrives a key per
/// read and pastes arrive bracketed, so anything else is `.other` and is
/// passed through untouched. Understands legacy bytes, kitty CSI-u (CC turns
/// the kitty protocol on when the terminal supports it) and xterm
/// modifyOtherKeys (`CSI 27;mods;code ~`).
pub fn decode(bytes: []const u8) Key {
    const eql = std.mem.eql;
    if (bytes.len == 0) return .other;
    if (bytes.len == 1) return switch (bytes[0]) {
        '\t' => .tab,
        '\r' => .enter,
        0x03 => .ctrl_c,
        0x1b => .esc,
        0x7f, 0x08 => .backspace,
        0x20...0x7e => .{ .char = bytes[0] },
        else => .other,
    };
    if (bytes[0] != 0x1b) {
        // One UTF-8 character.
        const n = std.unicode.utf8ByteSequenceLength(bytes[0]) catch return .other;
        if (n != bytes.len) return .other;
        return .{ .char = std.unicode.utf8Decode(bytes) catch return .other };
    }
    const legacy = [_]struct { []const u8, Key }{
        .{ "\x1b[A", .up },  .{ "\x1bOA", .up },  .{ "\x1b[B", .down }, .{ "\x1bOB", .down },
        .{ "\x1b[C", .right }, .{ "\x1bOC", .right }, .{ "\x1b[D", .left }, .{ "\x1bOD", .left },
        .{ "\x1b[Z", .shift_tab }, .{ "\x1b[I", .focus_in }, .{ "\x1b[O", .focus_out },
    };
    for (legacy) |e| if (eql(u8, bytes, e[0])) return e[1];
    if (decodeMouse(bytes)) |m| return .{ .mouse = m };
    if (bytes.len < 4 or bytes[1] != '[') return .other;

    // CSI params final: `code;mods[:event]u`, `27;mods;code~`, `1;mods A`.
    const final = bytes[bytes.len - 1];
    var nums: [3]u32 = .{ 0, 1, 1 }; // code, mods, event
    var n: usize = 0;
    var it = std.mem.tokenizeAny(u8, bytes[2 .. bytes.len - 1], ";");
    var fields: [3][]const u8 = undefined;
    while (it.next()) |f| : (n += 1) {
        if (n == 3) return .other;
        fields[n] = f;
    }
    if (n == 0) return .other;
    for (fields[0..n], 0..) |f, i| {
        var sub = std.mem.splitScalar(u8, f, ':');
        nums[i] = std.fmt.parseInt(u32, sub.first(), 10) catch return .other;
        if (i == 1) if (sub.next()) |ev| {
            nums[2] = std.fmt.parseInt(u32, ev, 10) catch return .other;
        };
    }
    var code: u32 = undefined;
    var mods: u32 = undefined;
    switch (final) {
        'u' => {
            code = nums[0];
            mods = if (n > 1) nums[1] else 1;
            if (nums[2] == 3) return .other; // key release
        },
        '~' => {
            if (n != 3 or nums[0] != 27) return .other;
            mods = nums[1];
            code = nums[2];
        },
        'A', 'B', 'C', 'D' => return switch (final) {
            'A' => .up,
            'B' => .down,
            'C' => .right,
            else => .left,
        },
        else => return .other,
    }
    const m = mods -| 1; // bit 0 shift, 1 alt, 2 ctrl
    const shift = m & 1 != 0;
    const ctrl = m & 4 != 0;
    if (m & ~@as(u32, 5) != 0) return .other; // alt / super / …
    return switch (code) {
        9 => if (shift) .shift_tab else .tab,
        13 => if (ctrl) .ctrl_enter else if (m == 0) .enter else .other,
        27 => .esc,
        127 => .backspace,
        'c' => if (ctrl) .ctrl_c else .{ .char = 'c' },
        else => if (!ctrl and code >= 0x20 and code <= 0x10FFFF) .{ .char = @intCast(code) } else .other,
    };
}

pub const left = "\x1b[D";
pub const delete = "\x1b[3~";
pub const backspace = "\x7f";

fn cpLen(s: []const u8) usize {
    return std.unicode.utf8CountCodepoints(s) catch s.len;
}

fn appendN(allocator: std.mem.Allocator, out: *std.ArrayList(u8), s: []const u8, n: usize) !void {
    for (0..n) |_| try out.appendSlice(allocator, s);
}

/// Ctrl+C with text in the box: wipe the caret's row and every row below.
/// ← to the start of the caret's row, then forward-Delete past the end
/// (overshooting is harmless). When the row followed a real newline, that
/// newline stays, leaving the caret on a fresh empty line to keep typing.
/// Returns null when Ctrl+C should go to CC as-is.
/// If the caret row and everything below are already blank (e.g. right
/// after a Ctrl+C), Backspace up into the previous row first and clear that,
/// so repeated Ctrl+C peels one line per press.
pub fn ctrlCPlan(allocator: std.mem.Allocator, box: *const screen.Box) !?[]u8 {
    if (box.empty) return null;
    const c = box.cursor orelse return null;
    var out: std.ArrayList(u8) = .{};
    errdefer out.deinit(allocator);
    var line = c.line;
    var col = c.col;
    if (line > 0 and allBlank(box.lines[line..])) {
        try out.appendSlice(allocator, backspace);
        line -= 1;
        col = cpLen(box.lines[line]);
    }
    try appendN(allocator, &out, left, col);
    var n: usize = 0;
    for (box.lines[line..]) |l| n += cpLen(l) + 1;
    try appendN(allocator, &out, delete, n);
    return try out.toOwnedSlice(allocator);
}

fn allBlank(lines: []const []u8) bool {
    for (lines) |l| if (std.mem.trim(u8, l, " ").len > 0) return false;
    return true;
}

/// Empty the whole box from wherever the caret is: Backspace back to the
/// start, Delete forward past the end (overshoot is harmless).
pub fn clearAllPlan(allocator: std.mem.Allocator, box: *const screen.Box) !?[]u8 {
    if (box.empty) return null;
    const c = box.cursor orelse return null;
    var before: usize = c.col;
    for (box.lines[0..c.line]) |l| before += cpLen(l) + 1;
    var total: usize = 0;
    for (box.lines) |l| total += cpLen(l) + 1;
    var out: std.ArrayList(u8) = .{};
    errdefer out.deinit(allocator);
    try appendN(allocator, &out, backspace, before);
    try appendN(allocator, &out, delete, total - @min(total, before));
    return try out.toOwnedSlice(allocator);
}

/// Completion prefixes handled by Tab.
pub const Completion = struct {
    /// Directory fzf walks.
    root: enum { cwd, home },
    /// Initial fzf query (token minus the prefix).
    query: []const u8,
};

pub fn completion(token: []const u8) ?Completion {
    if (std.mem.startsWith(u8, token, "./")) return .{ .root = .cwd, .query = token[2..] };
    if (std.mem.startsWith(u8, token, "/~/")) return .{ .root = .home, .query = token[3..] };
    return null;
}

/// What to type in place of the token for a picked `abs` path. Prompt mode
/// gets an @-mention, relative to the project root when inside it (CC's own
/// @ suggestions are root-relative even after a `cd`); bash mode gets the
/// bare path. Trailing space closes CC's @ popup.
pub fn mention(allocator: std.mem.Allocator, mode: screen.Mode, abs: []const u8, project_root: []const u8) ![]u8 {
    var path = abs;
    if (std.mem.startsWith(u8, abs, project_root) and abs.len > project_root.len and abs[project_root.len] == '/') {
        path = abs[project_root.len + 1 ..];
    }
    return switch (mode) {
        .prompt => std.fmt.allocPrint(allocator, "@{s} ", .{path}),
        .bash => std.fmt.allocPrint(allocator, "{s} ", .{path}),
    };
}

/// Enter on a single-line `/~/name`: the project directory `~/claude/name`
/// (Enter creates it and copies a launch command for it). Anything else: null.
pub fn cdTarget(allocator: std.mem.Allocator, box: *const screen.Box, home: []const u8) !?[]u8 {
    if (box.empty or box.mode != .prompt or box.lines.len != 1) return null;
    const text = std.mem.trim(u8, box.lines[0], " ");
    if (!std.mem.startsWith(u8, text, "/~/")) return null;
    if (std.mem.indexOfAny(u8, text, " \t") != null) return null;
    return try std.fs.path.resolve(allocator, &.{ home, "claude", text[3..] });
}

/// What to paste in a new terminal to open cld-pi in `dir`.
pub fn launchCommand(allocator: std.mem.Allocator, dir: []const u8) ![]u8 {
    const q = try shellQuote(allocator, dir);
    defer allocator.free(q);
    return std.fmt.allocPrint(allocator, "cd {s} && npx cld-pi", .{q});
}

/// Single-quote for a POSIX shell.
pub fn shellQuote(allocator: std.mem.Allocator, s: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .{};
    errdefer out.deinit(allocator);
    try out.append(allocator, '\'');
    for (s) |c| {
        if (c == '\'') try out.appendSlice(allocator, "'\\''") else try out.append(allocator, c);
    }
    try out.append(allocator, '\'');
    return out.toOwnedSlice(allocator);
}

// -------- tests --------

const testing = std.testing;

fn box1(text: []const u8, mode: screen.Mode) screen.Box {
    const S = struct {
        var lines: [1][]u8 = undefined;
    };
    S.lines[0] = @constCast(text);
    return .{ .top = 0, .bottom = 2, .mode = mode, .empty = false, .lines = &S.lines, .cursor = .{ .line = 0, .col = cpLen(text) } };
}

test "decode legacy, kitty CSI-u and modifyOtherKeys" {
    const t = testing;
    try t.expectEqual(Key.tab, decode("\t"));
    try t.expectEqual(Key.tab, decode("\x1b[9u"));
    try t.expectEqual(Key.shift_tab, decode("\x1b[Z"));
    try t.expectEqual(Key.shift_tab, decode("\x1b[9;2u"));
    try t.expectEqual(Key.enter, decode("\r"));
    try t.expectEqual(Key.enter, decode("\x1b[13u"));
    try t.expectEqual(Key.ctrl_enter, decode("\x1b[13;5u"));
    try t.expectEqual(Key.ctrl_enter, decode("\x1b[27;5;13~"));
    try t.expectEqual(Key.ctrl_c, decode("\x03"));
    try t.expectEqual(Key.ctrl_c, decode("\x1b[99;5u"));
    try t.expectEqual(Key.ctrl_c, decode("\x1b[99;5:1u"));
    try t.expectEqual(Key.other, decode("\x1b[99;5:3u"));
    try t.expectEqual(Key.esc, decode("\x1b"));
    try t.expectEqual(Key.esc, decode("\x1b[27u"));
    try t.expectEqual(Key.up, decode("\x1b[A"));
    try t.expectEqual(Key.down, decode("\x1b[1;5B"));
    try t.expectEqual(Key.focus_out, decode("\x1b[O"));
    try t.expectEqual(Key{ .char = 'x' }, decode("x"));
    try t.expectEqual(Key{ .char = 0x4F60 }, decode("你"));
    try t.expectEqual(Key{ .char = 'x' }, decode("\x1b[120u"));
    try t.expectEqual(Key.other, decode("\x1b[13;3u")); // alt+enter
    try t.expectEqual(Key.other, decode("a\t"));
    try t.expectEqual(Key.other, decode("\x1b[200~\t\x1b[201~"));
    try t.expectEqual(Key{ .mouse = .{ .button = 0, .x = 97, .y = 0, .press = true } }, decode("\x1b[<0;98;1M"));
    try t.expectEqual(Key{ .mouse = .{ .button = 0, .x = 4, .y = 9, .press = false } }, decode("\x1b[<0;5;10m"));
    try t.expectEqual(Key.other, decode("\x1b[<0;98;1M\x1b[<0;98;1m"));
}

test "ctrlCPlan: middle row of three" {
    var lines = [_][]u8{ @constCast("line1"), @constCast("line2"), @constCast("line3") };
    const b: screen.Box = .{ .top = 0, .bottom = 4, .mode = .prompt, .empty = false, .lines = &lines, .cursor = .{ .line = 1, .col = 5 } };
    const plan = (try ctrlCPlan(testing.allocator, &b)).?;
    defer testing.allocator.free(plan);
    try testing.expectEqual(@as(usize, 5), std.mem.count(u8, plan, left));
    try testing.expectEqual(@as(usize, 12), std.mem.count(u8, plan, delete));
}

test "ctrlCPlan: on an already-blank last row, peel the row above" {
    var lines = [_][]u8{ @constCast("line1"), @constCast("line2"), @constCast("") };
    const b: screen.Box = .{ .top = 0, .bottom = 4, .mode = .prompt, .empty = false, .lines = &lines, .cursor = .{ .line = 2, .col = 0 } };
    const plan = (try ctrlCPlan(testing.allocator, &b)).?;
    defer testing.allocator.free(plan);
    try testing.expect(std.mem.startsWith(u8, plan, backspace));
    try testing.expectEqual(@as(usize, 5), std.mem.count(u8, plan, left));
}

test "ctrlCPlan: empty box passes through" {
    var lines = [_][]u8{@constCast("")};
    const b: screen.Box = .{ .top = 0, .bottom = 2, .mode = .prompt, .empty = true, .lines = &lines, .cursor = null };
    try testing.expect((try ctrlCPlan(testing.allocator, &b)) == null);
}

test "clearAllPlan: caret mid second row" {
    var lines = [_][]u8{ @constCast("ab"), @constCast("cdef") };
    const b: screen.Box = .{ .top = 0, .bottom = 3, .mode = .bash, .empty = false, .lines = &lines, .cursor = .{ .line = 1, .col = 2 } };
    const plan = (try clearAllPlan(testing.allocator, &b)).?;
    defer testing.allocator.free(plan);
    try testing.expectEqual(@as(usize, 5), std.mem.count(u8, plan, backspace));
    try testing.expectEqual(@as(usize, 3), std.mem.count(u8, plan, delete));
}

test "completion prefixes" {
    try testing.expectEqualStrings("src/ma", completion("./src/ma").?.query);
    try testing.expect(completion("./").?.root == .cwd);
    try testing.expect(completion("/~/Doc").?.root == .home);
    try testing.expect(completion("src/ma") == null);
    try testing.expect(completion("//gh") == null);
}

test "mention" {
    const a = testing.allocator;
    const m1 = try mention(a, .prompt, "/p/root/src/x.zig", "/p/root");
    defer a.free(m1);
    try testing.expectEqualStrings("@src/x.zig ", m1);
    const m2 = try mention(a, .prompt, "/p/rootish/x", "/p/root");
    defer a.free(m2);
    try testing.expectEqualStrings("@/p/rootish/x ", m2);
    const m3 = try mention(a, .bash, "/p/root/src", "/p/root");
    defer a.free(m3);
    try testing.expectEqualStrings("src ", m3);
}

test "cdTarget: only single-line /~/" {
    const a = testing.allocator;
    const cases = .{
        .{ "/~/wtf", "/home/u/claude/wtf" },
        .{ "/~/proj/new", "/home/u/claude/proj/new" },
        .{ "/~/", "/home/u/claude" },
        .{ "/~/a/../b", "/home/u/claude/b" },
    };
    inline for (cases) |c| {
        const b = box1(c[0], .prompt);
        const got = (try cdTarget(a, &b, "/home/u")).?;
        defer a.free(got);
        try testing.expectEqualStrings(c[1], got);
    }
    inline for (.{ "~/x", "./x", "/tmp/x", "/clear", "hello", "/~/a b", "see /~/x" }) |t| {
        const b = box1(t, .prompt);
        try testing.expect((try cdTarget(a, &b, "/home/u")) == null);
    }
    const bash = box1("/~/x", .bash);
    try testing.expect((try cdTarget(a, &bash, "/home/u")) == null);
}

test "launchCommand" {
    const c = try launchCommand(testing.allocator, "/home/u/claude/it's");
    defer testing.allocator.free(c);
    try testing.expectEqualStrings("cd '/home/u/claude/it'\\''s' && npx cld-pi", c);
}

test "shellQuote" {
    const q = try shellQuote(testing.allocator, "it's");
    defer testing.allocator.free(q);
    try testing.expectEqualStrings("'it'\\''s'", q);
}
