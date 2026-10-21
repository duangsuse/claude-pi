//! ghostty-vt mirror of what CC has drawn on the real terminal. Fed with the
//! exact same bytes we forward to stdout, so the grid is the screen. Not
//! thread-safe: the caller (pi/main.zig) guards it with a mutex.
const std = @import("std");
const vt = @import("ghostty-vt");

pub const Grid = struct {
    term: vt.Terminal,
    stream: vt.ReadonlyStream,

    /// Heap-allocated because `stream` points back into `term`.
    pub fn create(allocator: std.mem.Allocator, cols: u16, rows: u16) !*Grid {
        const g = try allocator.create(Grid);
        errdefer allocator.destroy(g);
        g.term = try vt.Terminal.init(allocator, .{ .cols = cols, .rows = rows });
        g.stream = g.term.vtStream();
        return g;
    }

    pub fn destroy(self: *Grid, allocator: std.mem.Allocator) void {
        self.stream.deinit();
        self.term.deinit(allocator);
        allocator.destroy(self);
    }

    pub fn feed(self: *Grid, bytes: []const u8) void {
        self.stream.nextSlice(bytes) catch {};
    }

    pub fn resize(self: *Grid, allocator: std.mem.Allocator, cols: u16, rows: u16) void {
        self.term.resize(allocator, cols, rows) catch {};
    }

    pub fn onAltScreen(self: *const Grid) bool {
        return self.term.screens.active_key == .alternate;
    }

    /// Plain-text viewport, exactly `rows` lines (line N == screen row N).
    pub fn snapshot(self: *Grid, allocator: std.mem.Allocator) ![]u8 {
        const text = try self.term.plainString(allocator);
        defer allocator.free(text);
        var out: std.ArrayList(u8) = .{};
        errdefer out.deinit(allocator);
        try out.appendSlice(allocator, text);
        var lines: usize = if (text.len == 0) 0 else std.mem.count(u8, text, "\n") + 1;
        if (lines > 0) try out.append(allocator, '\n');
        while (lines < self.term.rows) : (lines += 1) try out.append(allocator, '\n');
        return out.toOwnedSlice(allocator);
    }
};

// -------- tests --------

const testing = std.testing;

test "snapshot pads to row count and tracks cursor moves" {
    const g = try Grid.create(testing.allocator, 20, 4);
    defer g.destroy(testing.allocator);
    g.feed("hello\r\n\x1b[3;1Hthird");
    const s = try g.snapshot(testing.allocator);
    defer testing.allocator.free(s);
    try testing.expectEqualStrings("hello\n\nthird\n\n", s);
}

test "alt screen detection" {
    const g = try Grid.create(testing.allocator, 20, 4);
    defer g.destroy(testing.allocator);
    try testing.expect(!g.onAltScreen());
    g.feed("\x1b[?1049h");
    try testing.expect(g.onAltScreen());
    g.feed("\x1b[?1049l");
    try testing.expect(!g.onAltScreen());
}

test "resize keeps working" {
    const g = try Grid.create(testing.allocator, 20, 4);
    defer g.destroy(testing.allocator);
    g.resize(testing.allocator, 40, 6);
    g.feed("\x1b[6;1Hbottom");
    const s = try g.snapshot(testing.allocator);
    defer testing.allocator.free(s);
    try testing.expectEqualStrings("\n\n\n\n\nbottom\n", s);
}
