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

    /// VT bytes that repaint the real terminal from the grid: screen,
    /// styles, cursor and modes (alt screen, mouse, bracketed paste, …).
    /// Used after something else (fzf) took over the terminal. Wrapped in
    /// synchronized output so it lands as one frame. No palette: that's the
    /// user's terminal's business.
    pub fn redraw(self: *Grid, allocator: std.mem.Allocator) ![]u8 {
        var out: std.ArrayList(u8) = .{};
        errdefer out.deinit(allocator);
        try out.appendSlice(allocator, "\x1b[?2026h");
        try self.redrawInto(allocator, &out);
        try out.appendSlice(allocator, "\x1b[?2026l");
        return out.toOwnedSlice(allocator);
    }

    /// `redraw` without the synchronized-output wrapper, appended to `out`.
    pub fn redrawInto(self: *Grid, allocator: std.mem.Allocator, out: *std.ArrayList(u8)) !void {
        var aw = std.Io.Writer.Allocating.fromArrayList(allocator, out);
        defer out.* = aw.toArrayList();
        const w = &aw.writer;
        if (self.onAltScreen()) try w.writeAll("\x1b[?1049h");
        try w.writeAll("\x1b[0m\x1b[H\x1b[2J");
        var f: vt.formatter.TerminalFormatter = .init(&self.term, .{ .emit = .vt, .trim = false });
        f.extra = .none;
        f.extra.modes = true;
        f.extra.keyboard = true;
        f.extra.screen = .none;
        f.extra.screen.cursor = true;
        f.extra.screen.style = true;
        try w.print("{f}", .{f});
        // Kitty flags go back as a push, not the formatter's `CSI = f;1 u`:
        // tmux ignores the set form, and CC pops its entry on exit anyway.
        const kitty = self.term.screens.active.kitty_keyboard.current().int();
        if (kitty != 0) try w.print("\x1b[>{d}u", .{kitty});
    }

    /// After painting over the screen: put the cursor position, SGR and
    /// cursor visibility back to what CC left (CC itself uses DECSC/DECRC,
    /// so we can't borrow them).
    pub fn restoreCursor(self: *Grid, allocator: std.mem.Allocator, out: *std.ArrayList(u8)) !void {
        var aw = std.Io.Writer.Allocating.fromArrayList(allocator, out);
        defer out.* = aw.toArrayList();
        var f: vt.formatter.ScreenFormatter = .init(self.term.screens.active, .{ .emit = .vt });
        f.content = .none;
        f.extra = .none;
        f.extra.cursor = true;
        f.extra.style = true;
        try aw.writer.writeAll("\x1b[0m");
        try aw.writer.print("{f}", .{f});
        try aw.writer.writeAll(if (self.term.modes.get(.cursor_visible)) "\x1b[?25h" else "\x1b[?25l");
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

test "redraw reproduces screen, cursor and alt screen" {
    inline for (.{ "multiline", "at_popup", "busy" }) |name| {
        const a = try Grid.create(testing.allocator, 100, 30);
        defer a.destroy(testing.allocator);
        a.feed(@embedFile("testdata/" ++ name ++ ".vt"));
        const bytes = try a.redraw(testing.allocator);
        defer testing.allocator.free(bytes);

        const b = try Grid.create(testing.allocator, 100, 30);
        defer b.destroy(testing.allocator);
        // Start from a primary screen with junk on it, like after fzf exits.
        b.feed("junk junk\r\n");
        b.feed(bytes);

        const sa = try a.snapshot(testing.allocator);
        defer testing.allocator.free(sa);
        const sb = try b.snapshot(testing.allocator);
        defer testing.allocator.free(sb);
        try testing.expectEqualStrings(sa, sb);
        try testing.expectEqual(a.onAltScreen(), b.onAltScreen());
        try testing.expectEqual(a.term.screens.active.cursor.x, b.term.screens.active.cursor.x);
        try testing.expectEqual(a.term.screens.active.cursor.y, b.term.screens.active.cursor.y);
        try testing.expectEqual(a.term.modes.get(.bracketed_paste), b.term.modes.get(.bracketed_paste));
        try testing.expectEqual(a.term.modes.get(.mouse_event_any), b.term.modes.get(.mouse_event_any));
    }
}

test "redraw restores kitty keyboard flags and modifyOtherKeys" {
    const a = try Grid.create(testing.allocator, 20, 4);
    defer a.destroy(testing.allocator);
    a.feed("\x1b[?1049h\x1b[>5u\x1b[>4;2mhi");
    const bytes = try a.redraw(testing.allocator);
    defer testing.allocator.free(bytes);

    const b = try Grid.create(testing.allocator, 20, 4);
    defer b.destroy(testing.allocator);
    // What fzf.prelude leaves behind.
    b.feed("\x1b[<99u\x1b[=0;1u\x1b[>4;0m");
    b.feed(bytes);
    try testing.expectEqual(@as(u5, 5), b.term.screens.active.kitty_keyboard.current().int());
    try testing.expect(b.term.flags.modify_other_keys_2);
}

test "restoreCursor puts cursor and SGR back after a paint" {
    const a = try Grid.create(testing.allocator, 20, 5);
    defer a.destroy(testing.allocator);
    a.feed("\x1b[3;7H\x1b[1;31m");
    var out: std.ArrayList(u8) = .{};
    defer out.deinit(testing.allocator);
    try out.appendSlice(testing.allocator, "\x1b[1;1H\x1b[0;44mpaint");
    try a.restoreCursor(testing.allocator, &out);

    const b = try Grid.create(testing.allocator, 20, 5);
    defer b.destroy(testing.allocator);
    b.feed(out.items);
    try testing.expectEqual(@as(u16, 6), b.term.screens.active.cursor.x);
    try testing.expectEqual(@as(u16, 2), b.term.screens.active.cursor.y);
    const st = b.term.screens.active.cursor.style;
    try testing.expect(st.flags.bold);
    try testing.expect(st.bg_color == .none);
}
