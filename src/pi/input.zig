//! Pure decision logic for the keys interactive mode intercepts. No I/O;
//! main.zig turns these decisions into pty writes / steps.
const std = @import("std");
const screen = @import("screen.zig");

pub const Key = enum { tab, enter, ctrl_c, other };

/// Only chunks that are exactly one of these keys are intercepted; typing
/// arrives a key per read, pastes arrive bracketed, so anything bigger is
/// passed through untouched. Both legacy bytes and kitty CSI-u forms (CC
/// turns the kitty protocol on when the terminal supports it).
pub fn classify(bytes: []const u8) Key {
    const eql = std.mem.eql;
    if (eql(u8, bytes, "\t") or eql(u8, bytes, "\x1b[9u")) return .tab;
    if (eql(u8, bytes, "\r") or eql(u8, bytes, "\x1b[13u")) return .enter;
    if (eql(u8, bytes, "\x03") or eql(u8, bytes, "\x1b[99;5u") or eql(u8, bytes, "\x1b[99;5:1u")) return .ctrl_c;
    return .other;
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

/// Enter on a single-line `/~/path`: the directory `~/path` (Enter creates
/// it). Same prefix as the `/~/` Tab completion. Anything else: null.
pub fn cdTarget(allocator: std.mem.Allocator, box: *const screen.Box, home: []const u8) !?[]u8 {
    if (box.empty or box.mode != .prompt or box.lines.len != 1) return null;
    const text = std.mem.trim(u8, box.lines[0], " ");
    if (!std.mem.startsWith(u8, text, "/~/")) return null;
    if (std.mem.indexOfAny(u8, text, " \t") != null) return null;
    return try std.fs.path.resolve(allocator, &.{ home, text[3..] });
}

/// `dir` is inside one of `allowed` (or equal to it).
pub fn isAllowed(dir: []const u8, allowed: []const []const u8) bool {
    for (allowed) |a| {
        if (std.mem.eql(u8, dir, a)) return true;
        if (std.mem.startsWith(u8, dir, a) and dir.len > a.len and (a[a.len - 1] == '/' or dir[a.len] == '/')) return true;
    }
    return false;
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

test "classify legacy and kitty forms" {
    try testing.expectEqual(Key.tab, classify("\t"));
    try testing.expectEqual(Key.tab, classify("\x1b[9u"));
    try testing.expectEqual(Key.enter, classify("\r"));
    try testing.expectEqual(Key.ctrl_c, classify("\x03"));
    try testing.expectEqual(Key.ctrl_c, classify("\x1b[99;5u"));
    try testing.expectEqual(Key.other, classify("a\t"));
    try testing.expectEqual(Key.other, classify("\x1b[200~\t\x1b[201~"));
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
        .{ "/~/proj/new", "/home/u/proj/new" },
        .{ "/~/", "/home/u" },
        .{ "/~/a/../b", "/home/u/b" },
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

test "isAllowed" {
    const allowed = [_][]const u8{ "/p/root", "/tmp/x" };
    try testing.expect(isAllowed("/p/root", &allowed));
    try testing.expect(isAllowed("/p/root/a/b", &allowed));
    try testing.expect(!isAllowed("/p/rootish", &allowed));
    try testing.expect(!isAllowed("/home", &allowed));
}

test "shellQuote" {
    const q = try shellQuote(testing.allocator, "it's");
    defer testing.allocator.free(q);
    try testing.expectEqualStrings("'it'\\''s'", q);
}
