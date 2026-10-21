//! Heuristics for reading CC's fullscreen UI off the ghostty-vt grid. Every
//! rule that depends on how CC draws itself lives here, so a CC redesign is
//! a one-file fix; the regression tests replay real CC byte streams from
//! testdata/ (captured through claude-p at 100x30).
//!
//! The input box, as CC 2.1 draws it:
//!
//!   ─────────────────────   full-width U+2500 border (fg #888888)
//!   ❯␣hello world           ❯ (or ! in bash mode) + NBSP, then the text
//!   ␣␣second line           continuation rows are indented 2 cells
//!   ─────────────────────
//!
//! An empty box shows a faint (SGR 2) placeholder, or nothing after /clear.
//! CC parks the real cursor at the caret, so the grid cursor is the caret.
const std = @import("std");
const vt = @import("ghostty-vt");

pub const Mode = enum { prompt, bash };

pub const Box = struct {
    /// Row of the top border; content rows are top+1 .. bottom-1.
    top: u16,
    bottom: u16,
    mode: Mode,
    /// Placeholder only, or no text at all.
    empty: bool,
    /// Text of each content row after the 2-cell prefix, right-trimmed.
    lines: [][]u8,
    /// Caret position: content row index and number of codepoints before it.
    cursor: ?struct { line: usize, col: usize },

    pub fn deinit(self: *Box, allocator: std.mem.Allocator) void {
        for (self.lines) |l| allocator.free(l);
        allocator.free(self.lines);
    }

    /// Text on the caret's row before the caret.
    pub fn beforeCursor(self: *const Box) ?[]const u8 {
        const c = self.cursor orelse return null;
        const line = self.lines[c.line];
        var it = std.unicode.Utf8View.initUnchecked(line).iterator();
        var n: usize = 0;
        while (n < c.col) : (n += 1) _ = it.nextCodepoint() orelse break;
        return line[0..it.i];
    }

    /// The whitespace-delimited word ending at the caret (may be empty).
    pub fn tokenBeforeCursor(self: *const Box) ?[]const u8 {
        const before = self.beforeCursor() orelse return null;
        const start = if (std.mem.lastIndexOfScalar(u8, before, ' ')) |i| i + 1 else 0;
        return before[start..];
    }
};

/// What identifies the TUI's parts on screen. The defaults are CC's (the
/// hardcoded fast path); `pi.arg.border` / `prompt` / `bash` / `busy` /
/// `running` override them for another TUI (`cld-pi -a <cmd>`).
pub const Rules = struct {
    border: u21 = 0x2500, // ─, a full-width row of it
    prompt: u21 = 0x276F, // ❯ + space/NBSP opens the input box
    bash: u21 = '!', // same, in bash mode
    busy: []const u8 = "esc to interrupt",
    running: []const u8 = "Running\u{2026}",
};

const nbsp: u21 = 0xA0;

fn cellAt(term: *vt.Terminal, x: usize, y: usize) ?vt.PageList.Cell {
    return term.screens.active.pages.getCell(.{ .active = .{ .x = @intCast(x), .y = @intCast(y) } });
}

fn cp(term: *vt.Terminal, x: usize, y: usize) u21 {
    const c = cellAt(term, x, y) orelse return 0;
    return c.cell.codepoint();
}

fn isBorderRow(term: *vt.Terminal, y: usize, rules: *const Rules) bool {
    for (0..term.cols) |x| if (cp(term, x, y) != rules.border) return false;
    return true;
}

fn promptMode(term: *vt.Terminal, y: usize, rules: *const Rules) ?Mode {
    const sep = cp(term, 1, y);
    if (sep != nbsp and sep != ' ') return null;
    const c = cp(term, 0, y);
    return if (c == rules.prompt) .prompt else if (c == rules.bash) .bash else null;
}

const RowText = struct { text: []u8, faint_only: bool, cursor_col: ?usize };

/// Text of row `y` from cell 2 on. `faint_only` is true when every visible
/// glyph is faint (i.e. it's a placeholder). `cursor_col` counts codepoints
/// left of `cursor_x` when given.
fn rowText(allocator: std.mem.Allocator, term: *vt.Terminal, y: usize, cursor_x: ?usize) !RowText {
    var out: std.ArrayList(u8) = .{};
    errdefer out.deinit(allocator);
    var faint_only = true;
    var count: usize = 0;
    var cursor_col: ?usize = null;
    for (2..term.cols) |x| {
        if (cursor_x) |cx| if (x == cx) {
            cursor_col = count;
        };
        const c = cellAt(term, x, y) orelse break;
        switch (c.cell.wide) {
            .spacer_tail, .spacer_head => continue,
            else => {},
        }
        var ch = c.cell.codepoint();
        if (ch == 0 or ch == nbsp) ch = ' ';
        if (ch != ' ' and !c.style().flags.faint) faint_only = false;
        var buf: [4]u8 = undefined;
        const n = std.unicode.utf8Encode(ch, &buf) catch 1;
        try out.appendSlice(allocator, buf[0..n]);
        count += 1;
    }
    if (cursor_x) |cx| if (cx >= term.cols) {
        cursor_col = count;
    };
    // Right-trim, but never past the caret.
    var keep = std.mem.trimRight(u8, out.items, " ").len;
    if (cursor_col) |cc| {
        var it = std.unicode.Utf8View.initUnchecked(out.items).iterator();
        var n: usize = 0;
        while (n < cc) : (n += 1) _ = it.nextCodepoint() orelse break;
        keep = @max(keep, it.i);
    }
    out.shrinkRetainingCapacity(keep);
    return .{ .text = try out.toOwnedSlice(allocator), .faint_only = faint_only, .cursor_col = cursor_col };
}

/// Find CC's input box (the bottom-most one). Null while a dialog or
/// anything else has replaced it.
pub fn inputBox(allocator: std.mem.Allocator, term: *vt.Terminal) !?Box {
    return inputBoxWith(allocator, term, &.{});
}

pub fn inputBoxWith(allocator: std.mem.Allocator, term: *vt.Terminal, rules: *const Rules) !?Box {
    var y: usize = term.rows;
    var below: ?usize = null;
    while (y > 0) {
        y -= 1;
        if (!isBorderRow(term, y, rules)) continue;
        if (below) |b| {
            if (b - y >= 2) if (promptMode(term, y + 1, rules)) |mode| return try buildBox(allocator, term, y, b, mode);
        }
        below = y;
    }
    return null;
}

fn buildBox(allocator: std.mem.Allocator, term: *vt.Terminal, top: usize, bottom: usize, mode: Mode) !Box {
    const cur = term.screens.active.cursor;
    var lines: std.ArrayList([]u8) = .{};
    errdefer {
        for (lines.items) |l| allocator.free(l);
        lines.deinit(allocator);
    }
    var empty = true;
    var cursor: @FieldType(Box, "cursor") = null;
    for (top + 1..bottom) |row| {
        const on_cursor = cur.y == row and cur.x >= 2;
        const rt = try rowText(allocator, term, row, if (on_cursor) cur.x else null);
        if (std.mem.trim(u8, rt.text, " ").len > 0 and !rt.faint_only) empty = false;
        if (rt.cursor_col) |cc| cursor = .{ .line = row - top - 1, .col = cc };
        try lines.append(allocator, rt.text);
    }
    // A placeholder isn't text: report no lines' worth of content.
    if (empty) for (lines.items) |l| {
        @memset(l, ' ');
    };
    return .{
        .top = @intCast(top),
        .bottom = @intCast(bottom),
        .mode = mode,
        .empty = empty,
        .lines = try lines.toOwnedSlice(allocator),
        .cursor = if (empty) null else cursor,
    };
}

pub fn contains(allocator: std.mem.Allocator, term: *vt.Terminal, needle: []const u8) bool {
    const text = term.plainString(allocator) catch return false;
    defer allocator.free(text);
    return std.mem.indexOf(u8, text, needle) != null;
}

/// CC is running a turn (spinner + "esc to interrupt" in the status line).
pub fn isBusy(allocator: std.mem.Allocator, term: *vt.Terminal, rules: *const Rules) bool {
    return contains(allocator, term, rules.busy);
}

/// A `!` command (or any tool) is still executing: its result line reads
/// "⎿ ␣Running…" (space + NBSP).
pub fn commandRunning(allocator: std.mem.Allocator, term: *vt.Terminal, rules: *const Rules) bool {
    return contains(allocator, term, rules.running);
}

// -------- tests --------

const testing = std.testing;
const Grid = @import("grid.zig").Grid;

fn load(comptime name: []const u8) !*Grid {
    const g = try Grid.create(testing.allocator, 100, 30);
    g.feed(@embedFile("testdata/" ++ name ++ ".vt"));
    return g;
}

fn expectBox(comptime name: []const u8) !Box {
    const g = try load(name);
    defer g.destroy(testing.allocator);
    return (try inputBox(testing.allocator, &g.term)) orelse error.NoBox;
}

test "placeholder counts as empty" {
    var b = try expectBox("placeholder");
    defer b.deinit(testing.allocator);
    try testing.expectEqual(Mode.prompt, b.mode);
    try testing.expect(b.empty);
    try testing.expectEqual(@as(usize, 1), b.lines.len);
}

test "typed text, caret at end" {
    var b = try expectBox("typed");
    defer b.deinit(testing.allocator);
    try testing.expect(!b.empty);
    try testing.expectEqualStrings("hello world", b.lines[0]);
    try testing.expectEqual(@as(usize, 0), b.cursor.?.line);
    try testing.expectEqual(@as(usize, 11), b.cursor.?.col);
    try testing.expectEqualStrings("world", b.tokenBeforeCursor().?);
}

test "multi-line input" {
    var b = try expectBox("multiline");
    defer b.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 2), b.lines.len);
    try testing.expectEqualStrings("hello world", b.lines[0]);
    try testing.expectEqualStrings("second line", b.lines[1]);
    try testing.expectEqual(@as(usize, 1), b.cursor.?.line);
}

test "caret moved up into the middle row" {
    var b = try expectBox("cursor_mid");
    defer b.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 3), b.lines.len);
    try testing.expectEqual(@as(usize, 1), b.cursor.?.line);
    try testing.expectEqual(@as(usize, 5), b.cursor.?.col);
}

test "bash mode prompt" {
    var b = try expectBox("bash_mode");
    defer b.deinit(testing.allocator);
    try testing.expectEqual(Mode.bash, b.mode);
    try testing.expect(b.empty);
}

test "dialog replaces the box" {
    const g = try load("dialog");
    defer g.destroy(testing.allocator);
    try testing.expect((try inputBox(testing.allocator, &g.term)) == null);
}

test "rules: another TUI's glyphs don't match CC's box" {
    const g = try load("typed");
    defer g.destroy(testing.allocator);
    try testing.expect((try inputBoxWith(testing.allocator, &g.term, &.{ .prompt = '>' })) == null);
    var b = (try inputBoxWith(testing.allocator, &g.term, &.{ .prompt = '>', .bash = 0x276F })).?;
    defer b.deinit(testing.allocator);
    try testing.expectEqual(Mode.bash, b.mode);
}

test "busy vs idle" {
    const g = try load("busy");
    defer g.destroy(testing.allocator);
    try testing.expect(isBusy(testing.allocator, &g.term, &.{}));
    var b = (try inputBox(testing.allocator, &g.term)).?;
    defer b.deinit(testing.allocator);
    try testing.expect(b.empty);

    const g2 = try load("cleared");
    defer g2.destroy(testing.allocator);
    try testing.expect(!isBusy(testing.allocator, &g2.term, &.{}));
    var b2 = (try inputBox(testing.allocator, &g2.term)).?;
    defer b2.deinit(testing.allocator);
    try testing.expect(b2.empty);
}

test "CC's own @ popup above the box doesn't confuse detection" {
    var b = try expectBox("at_popup");
    defer b.deinit(testing.allocator);
    try testing.expectEqualStrings("@src/ma", b.lines[0]);
    try testing.expectEqualStrings("@src/ma", b.tokenBeforeCursor().?);
}

test "token is the word before the caret" {
    var lines = [_][]u8{@constCast("see ./src/ma please")};
    const b: Box = .{ .top = 0, .bottom = 2, .mode = .prompt, .empty = false, .lines = &lines, .cursor = .{ .line = 0, .col = 12 } };
    try testing.expectEqualStrings("./src/ma", b.tokenBeforeCursor().?);
}
