//! What the wrapper paints on top of CC: a gum-style centered dialog, a
//! dropdown menu above the input box, and per-row paints from `pi.sed`.
//! CC's byte stream is never rewritten; main.zig appends `render()` after
//! every CC chunk (same write, inside synchronized output), so CC can't
//! leave a frame with the overlay missing. Closing repaints from the grid.
const std = @import("std");

/// gum's palette: pink accent (212), light text on gray for idle buttons.
const accent = "\x1b[38;5;212m";
const btn_on = "\x1b[1;38;5;230;48;5;212m";
const btn_off = "\x1b[38;5;252;48;5;238m";
const faint = "\x1b[2m";
const bold = "\x1b[1m";
const reset = "\x1b[0m";

pub const Dialog = struct {
    id: u32,
    title: []u8,
    body: []u8,
    footer: []u8,
    buttons: [][]u8,
    active: usize = 0,
    /// `eachRow`: buttons per row (owned; the last count repeats). Empty:
    /// all on one row. All ones: a list (full-width rows).
    layout: []u8 = &.{},

    fn deinit(self: *Dialog, a: std.mem.Allocator) void {
        a.free(self.title);
        a.free(self.body);
        a.free(self.footer);
        for (self.buttons) |b| a.free(b);
        a.free(self.buttons);
        a.free(self.layout);
    }

    pub const Span = struct { start: usize, len: usize };
    pub const max_rows = 64;

    /// Which buttons sit on which row.
    pub fn rows(self: *const Dialog, buf: *[max_rows]Span) []Span {
        const n = self.buttons.len;
        if (n == 0) return buf[0..0];
        if (self.layout.len == 0) {
            buf[0] = .{ .start = 0, .len = n };
            return buf[0..1];
        }
        var i: usize = 0;
        var k: usize = 0;
        while (i < n and k < max_rows) : (k += 1) {
            const c = @max(1, self.layout[@min(k, self.layout.len - 1)]);
            buf[k] = .{ .start = i, .len = @min(c, n - i) };
            i += buf[k].len;
        }
        return buf[0..k];
    }

    fn isList(self: *const Dialog, spans: []const Span) bool {
        if (self.layout.len == 0 or spans.len < 2) return false;
        for (spans) |sp| if (sp.len != 1) return false;
        return true;
    }

    pub const Move = enum { prev, next, up, down };

    /// ←/→/Tab walk the buttons in order; ↑/↓ change row, keeping the column.
    pub fn move(self: *Dialog, dir: Move) void {
        const n = self.buttons.len;
        if (n == 0) return;
        switch (dir) {
            .prev => self.active = (self.active + n - 1) % n,
            .next => self.active = (self.active + 1) % n,
            .up, .down => {
                var buf: [max_rows]Span = undefined;
                const spans = self.rows(&buf);
                var r: usize = 0;
                while (r + 1 < spans.len and self.active >= spans[r + 1].start) r += 1;
                const col = self.active - spans[r].start;
                const to = if (dir == .up) (r + spans.len - 1) % spans.len else (r + 1) % spans.len;
                self.active = spans[to].start + @min(col, spans[to].len - 1);
            },
        }
    }
};

pub const Menu = struct {
    id: u32,
    items: [][]u8,
    active: usize = 0,
    /// Screen row just above which the list ends (the input box top border)
    /// and the column it starts at.
    bottom: u16,
    col: u16,

    fn deinit(self: *Menu, a: std.mem.Allocator) void {
        for (self.items) |i| a.free(i);
        a.free(self.items);
    }
};

pub const Overlay = struct {
    allocator: std.mem.Allocator,
    /// Modal dialog: centered, takes the keyboard.
    dialog: ?Dialog = null,
    /// Non-modal dialog (`timeout`): top-right, keys keep going to CC.
    toast: ?Dialog = null,
    /// Clickable label in the top-right corner (the plugin list).
    badge: ?[]u8 = null,
    menu: ?Menu = null,
    /// Row paints: replacement text for the row, may carry SGR; "" blanks it.
    paints: std.AutoArrayHashMapUnmanaged(u16, []u8) = .{},

    pub fn deinit(self: *Overlay) void {
        self.closeDialog();
        self.closeToast();
        self.setBadge(null);
        self.closeMenu();
        self.clearPaints();
        self.paints.deinit(self.allocator);
    }

    pub fn active(self: *const Overlay) bool {
        return self.dialog != null or self.toast != null or self.badge != null or
            self.menu != null or self.paints.count() > 0;
    }

    pub fn openDialog(self: *Overlay, d: Dialog) void {
        self.closeDialog();
        self.dialog = d;
    }

    pub fn closeDialog(self: *Overlay) void {
        if (self.dialog) |*d| d.deinit(self.allocator);
        self.dialog = null;
    }

    pub fn openToast(self: *Overlay, d: Dialog) void {
        self.closeToast();
        self.toast = d;
    }

    pub fn closeToast(self: *Overlay) void {
        if (self.toast) |*d| d.deinit(self.allocator);
        self.toast = null;
    }

    /// Modal or non-modal dialog with this id.
    pub fn findDialog(self: *Overlay, id: usize) ?*Dialog {
        if (self.dialog) |*d| if (d.id == id) return d;
        if (self.toast) |*d| if (d.id == id) return d;
        return null;
    }

    pub fn closeById(self: *Overlay, id: usize) void {
        if (self.dialog) |d| if (d.id == id) return self.closeDialog();
        if (self.toast) |d| if (d.id == id) return self.closeToast();
    }

    /// Takes ownership of `text`.
    pub fn setBadge(self: *Overlay, text: ?[]u8) void {
        if (self.badge) |b| self.allocator.free(b);
        self.badge = text;
    }

    /// Whether screen cell (x, y) is on the badge.
    pub fn badgeHit(self: *const Overlay, x: u16, y: u16, cols: u16) bool {
        const b = self.badge orelse return false;
        return y == 0 and x >= cols -| @as(u16, @intCast(width(b)));
    }

    pub fn openMenu(self: *Overlay, m: Menu) void {
        self.closeMenu();
        self.menu = m;
    }

    pub fn closeMenu(self: *Overlay) void {
        if (self.menu) |*m| m.deinit(self.allocator);
        self.menu = null;
    }

    pub fn clearPaints(self: *Overlay) void {
        for (self.paints.values()) |t| self.allocator.free(t);
        self.paints.clearRetainingCapacity();
    }

    /// Replace all row paints. Takes ownership of the texts.
    pub fn setPaints(self: *Overlay, rows: []const u16, texts: []const []u8) !void {
        self.clearPaints();
        for (rows, texts) |r, t| try self.paints.put(self.allocator, r, t);
    }

    /// Bytes painting everything at absolute positions. The caller restores
    /// CC's cursor and SGR afterwards.
    pub fn render(self: *const Overlay, out: *std.ArrayList(u8), cols: u16, rows: u16) !void {
        const a = self.allocator;
        var it = self.paints.iterator();
        while (it.next()) |e| {
            if (e.key_ptr.* >= rows) continue;
            try out.print(a, "\x1b[{d};1H" ++ reset ++ "\x1b[2K", .{e.key_ptr.* + 1});
            try out.appendSlice(a, e.value_ptr.*);
            try out.appendSlice(a, reset);
        }
        if (self.badge) |b| {
            const w: u16 = @intCast(@min(width(b), cols));
            try out.print(a, "\x1b[1;{d}H" ++ reset ++ btn_on, .{cols - w + 1});
            try truncate(a, out, b, w);
            try out.appendSlice(a, reset);
        }
        if (self.menu) |*m| try renderMenu(a, out, m, cols);
        if (self.toast) |*d| try renderDialog(a, out, d, cols, rows, .top_right);
        if (self.dialog) |*d| try renderDialog(a, out, d, cols, rows, .center);
    }
};

fn renderMenu(a: std.mem.Allocator, out: *std.ArrayList(u8), m: *const Menu, cols: u16) !void {
    var w: usize = 0;
    for (m.items) |i| w = @max(w, width(i));
    w = @min(w + 2, @as(usize, cols) -| m.col);
    const n = @min(m.items.len, m.bottom);
    // Keep the active item visible when the list is longer than the space.
    const first = if (m.active >= n) m.active + 1 - n else 0;
    for (0..n) |k| {
        const idx = first + k;
        const row = m.bottom - n + k; // 0-based screen row
        try out.print(a, "\x1b[{d};{d}H" ++ reset, .{ row + 1, m.col + 1 });
        try out.appendSlice(a, if (idx == m.active) btn_on else btn_off);
        try padded(a, out, m.items[idx], w, 1);
        try out.appendSlice(a, reset);
    }
}

const Placement = enum { center, top_right };

fn renderDialog(a: std.mem.Allocator, out: *std.ArrayList(u8), d: *const Dialog, cols: u16, rows: u16, place: Placement) !void {
    // Content lines: title, blank, body…, then buttons, footer.
    var lines: std.ArrayList(struct { text: []const u8, style: []const u8 }) = .{};
    defer lines.deinit(a);
    if (d.title.len > 0) {
        try lines.append(a, .{ .text = d.title, .style = bold ++ accent });
        try lines.append(a, .{ .text = "", .style = "" });
    }
    var body_it = std.mem.splitScalar(u8, d.body, '\n');
    if (d.body.len > 0) while (body_it.next()) |l| try lines.append(a, .{ .text = l, .style = "" });

    // One row: right-aligned like gum confirm. A list (eachRow 'vertical'):
    // full-width rows. A grid (eachRow [4, 5, 3]): every row spans the full
    // width, its buttons sharing it equally, so rows of 3 and 5 balance.
    var span_buf: [Dialog.max_rows]Dialog.Span = undefined;
    const spans = d.rows(&span_buf);
    const list = d.isList(spans);
    const grid = spans.len > 1 and !list;
    var btn_w: usize = 0;
    for (spans) |sp| {
        var row_w: usize = 0;
        var widest: usize = 0;
        for (d.buttons[sp.start..][0..sp.len]) |b| {
            row_w += width(b) + 4;
            widest = @max(widest, width(b) + 2);
        }
        // A justified row needs room for n cells as wide as its widest label.
        btn_w = @max(btn_w, if (grid) widest * sp.len + 2 * (sp.len - 1) else row_w -| 2);
    }
    const btn_rows: usize = spans.len;

    var inner: usize = btn_w;
    for (lines.items) |l| inner = @max(inner, width(l.text));
    inner = @max(inner, width(d.footer));
    inner = @max(@min(inner, @as(usize, cols) -| 6), 10);
    const box_w = inner + 4;
    const extra: usize = (if (btn_rows > 0) btn_rows + 1 else 0) + (if (d.footer.len > 0) @as(usize, 1) else 0);
    const box_h = @min(lines.items.len + extra + 2, rows);
    const x0 = switch (place) {
        .center => (@as(usize, cols) -| box_w) / 2 + 1,
        .top_right => (@as(usize, cols) -| box_w -| 1) + 1,
    };
    const y0 = switch (place) {
        .center => (@as(usize, rows) -| box_h) / 2 + 1,
        .top_right => 2, // under the badge row
    };

    var y = y0;
    try out.print(a, "\x1b[{d};{d}H" ++ reset ++ accent ++ "╭", .{ y, x0 });
    try repeat(a, out, "─", inner + 2);
    try out.appendSlice(a, "╮" ++ reset);
    const room = (box_h -| 2) -| extra; // body lines that fit
    for (lines.items[0..@min(lines.items.len, room)]) |l| {
        y += 1;
        try sideOpen(a, out, y, x0);
        try out.appendSlice(a, l.style);
        try padded(a, out, l.text, inner, 0);
        try sideClose(a, out);
    }
    if (btn_rows > 0) {
        if (lines.items.len > 0) {
            y += 1;
            try sideOpen(a, out, y, x0);
            try repeat(a, out, " ", inner);
            try sideClose(a, out);
        }
        for (spans) |sp| {
            y += 1;
            try sideOpen(a, out, y, x0);
            if (list) {
                try out.appendSlice(a, if (sp.start == d.active) btn_on else btn_off);
                try padded(a, out, d.buttons[sp.start], inner, 1);
            } else if (grid) {
                // Equal cells across the full width, labels centered.
                const gaps = 2 * (sp.len - 1);
                const cell = (inner -| gaps) / sp.len;
                var spare = (inner -| gaps) - cell * sp.len;
                var used: usize = 0;
                for (d.buttons[sp.start..][0..sp.len], 0..) |b, j| {
                    if (j > 0) {
                        try out.appendSlice(a, "  ");
                        used += 2;
                    }
                    const w = cell + @as(usize, if (spare > 0) 1 else 0);
                    spare -|= 1;
                    const lead = (w -| @min(width(b), w)) / 2;
                    try out.appendSlice(a, if (sp.start + j == d.active) btn_on else btn_off);
                    try padded(a, out, b, w, lead);
                    try out.appendSlice(a, reset);
                    used += w;
                }
                try repeat(a, out, " ", inner -| used);
            } else {
                try repeat(a, out, " ", inner -| btn_w);
                for (d.buttons[sp.start..][0..sp.len], 0..) |b, j| {
                    if (j > 0) try out.appendSlice(a, "  ");
                    try out.appendSlice(a, if (sp.start + j == d.active) btn_on else btn_off);
                    try padded(a, out, b, width(b) + 2, 1);
                    try out.appendSlice(a, reset);
                }
            }
            try sideClose(a, out);
        }
    }
    if (d.footer.len > 0) {
        y += 1;
        try sideOpen(a, out, y, x0);
        try out.appendSlice(a, faint);
        try padded(a, out, d.footer, inner, 0);
        try sideClose(a, out);
    }
    y += 1;
    try out.print(a, "\x1b[{d};{d}H" ++ reset ++ accent ++ "╰", .{ y, x0 });
    try repeat(a, out, "─", inner + 2);
    try out.appendSlice(a, "╯" ++ reset);
}

fn sideOpen(a: std.mem.Allocator, out: *std.ArrayList(u8), y: usize, x0: usize) !void {
    try out.print(a, "\x1b[{d};{d}H" ++ reset ++ accent ++ "│" ++ reset ++ " ", .{ y, x0 });
}

fn sideClose(a: std.mem.Allocator, out: *std.ArrayList(u8)) !void {
    try out.appendSlice(a, reset ++ " " ++ accent ++ "│" ++ reset);
}

fn repeat(a: std.mem.Allocator, out: *std.ArrayList(u8), s: []const u8, n: usize) !void {
    for (0..n) |_| try out.appendSlice(a, s);
}

/// `s` cut to `w` columns.
fn truncate(a: std.mem.Allocator, out: *std.ArrayList(u8), s: []const u8, w: usize) !void {
    var used: usize = 0;
    var it = (std.unicode.Utf8View.init(s) catch return out.appendSlice(a, s)).iterator();
    while (it.nextCodepointSlice()) |cs| {
        const cw = cpWidth(std.unicode.utf8Decode(cs) catch '?');
        if (used + cw > w) break;
        used += cw;
        try out.appendSlice(a, cs);
    }
}

/// `s` with `lead` spaces before, cut/padded to exactly `w` columns.
fn padded(a: std.mem.Allocator, out: *std.ArrayList(u8), s: []const u8, w: usize, lead: usize) !void {
    try repeat(a, out, " ", @min(lead, w));
    const room = w -| lead;
    try truncate(a, out, s, room);
    try repeat(a, out, " ", room -| @min(width(s), room));
}

/// Display width of plain text (no escape sequences).
pub fn width(s: []const u8) usize {
    var n: usize = 0;
    var it = (std.unicode.Utf8View.init(s) catch return s.len).iterator();
    while (it.nextCodepoint()) |c| n += cpWidth(c);
    return n;
}

fn cpWidth(c: u21) usize {
    if (c < 0x20 or (c >= 0x7f and c < 0xa0)) return 0;
    if ((c >= 0x300 and c <= 0x36f) or c == 0x200d or (c >= 0xfe00 and c <= 0xfe0f)) return 0;
    const wide = (c >= 0x1100 and c <= 0x115f) or (c >= 0x2e80 and c <= 0xa4cf) or
        (c >= 0xac00 and c <= 0xd7a3) or (c >= 0xf900 and c <= 0xfaff) or
        (c >= 0xfe30 and c <= 0xfe4f) or (c >= 0xff00 and c <= 0xff60) or
        (c >= 0xffe0 and c <= 0xffe6) or (c >= 0x1f300 and c <= 0x1f64f) or
        (c >= 0x1f900 and c <= 0x1f9ff) or (c >= 0x20000 and c <= 0x3fffd);
    return if (wide) 2 else 1;
}

// -------- tests --------

const testing = std.testing;
const Grid = @import("grid.zig").Grid;

fn dupe(s: []const u8) []u8 {
    return testing.allocator.dupe(u8, s) catch unreachable;
}

fn testDialog(buttons: []const []const u8) Dialog {
    const bs = testing.allocator.alloc([]u8, buttons.len) catch unreachable;
    for (buttons, 0..) |b, i| bs[i] = dupe(b);
    return .{ .id = 1, .title = dupe("Settings"), .body = dupe("row one\n中文第二行"), .footer = dupe("esc to close"), .buttons = bs };
}

test "width counts CJK as two columns" {
    try testing.expectEqual(@as(usize, 5), width("hello"));
    try testing.expectEqual(@as(usize, 4), width("中文"));
}

test "dialog renders a centered box over the grid" {
    var o: Overlay = .{ .allocator = testing.allocator };
    defer o.deinit();
    o.openDialog(testDialog(&.{ "OK", "Cancel" }));

    var out: std.ArrayList(u8) = .{};
    defer out.deinit(testing.allocator);
    try o.render(&out, 60, 20);

    const g = try Grid.create(testing.allocator, 60, 20);
    defer g.destroy(testing.allocator);
    g.feed(out.items);
    const s = try g.snapshot(testing.allocator);
    defer testing.allocator.free(s);
    var lines = std.mem.splitScalar(u8, s, '\n');
    var top: ?usize = null;
    var i: usize = 0;
    var found_buttons = false;
    var found_cjk = false;
    while (lines.next()) |l| : (i += 1) {
        if (top == null and std.mem.indexOf(u8, l, "╭") != null) top = i;
        if (std.mem.indexOf(u8, l, " OK ") != null and std.mem.indexOf(u8, l, " Cancel ") != null) found_buttons = true;
        if (std.mem.indexOf(u8, l, "中文第二行") != null) found_cjk = true;
    }
    try testing.expect(found_buttons);
    try testing.expect(found_cjk);
    // 9 rows tall (border, title, blank, 2 body, blank, buttons, footer, border) → top at (20-9)/2.
    try testing.expectEqual(@as(?usize, 5), top);
}

test "menu sits right above the anchor row, active item kept visible" {
    var o: Overlay = .{ .allocator = testing.allocator };
    defer o.deinit();
    const items = try testing.allocator.alloc([]u8, 5);
    for (items, 0..) |*it, k| it.* = try std.fmt.allocPrint(testing.allocator, "item{d}", .{k});
    o.openMenu(.{ .id = 2, .items = items, .active = 4, .bottom = 3, .col = 2 });

    var out: std.ArrayList(u8) = .{};
    defer out.deinit(testing.allocator);
    try o.render(&out, 40, 10);
    const g = try Grid.create(testing.allocator, 40, 10);
    defer g.destroy(testing.allocator);
    g.feed(out.items);
    const s = try g.snapshot(testing.allocator);
    defer testing.allocator.free(s);
    // Items are padded with background-colored spaces, so the trailing
    // space is content.
    try testing.expect(std.mem.startsWith(u8, s, "   item2 \n   item3 \n   item4 \n"));
}

test "row paints replace or blank rows" {
    var o: Overlay = .{ .allocator = testing.allocator };
    defer o.deinit();
    try o.setPaints(&.{ 0, 1 }, &.{ dupe("painted"), dupe("") });
    var out: std.ArrayList(u8) = .{};
    defer out.deinit(testing.allocator);
    try o.render(&out, 20, 3);
    const g = try Grid.create(testing.allocator, 20, 3);
    defer g.destroy(testing.allocator);
    g.feed("aaaa\r\nbbbb\r\ncccc");
    g.feed(out.items);
    const s = try g.snapshot(testing.allocator);
    defer testing.allocator.free(s);
    try testing.expectEqualStrings("painted\n\ncccc\n", s);
}

test "vertical buttons, toast placement and the badge" {
    var o: Overlay = .{ .allocator = testing.allocator };
    defer o.deinit();
    var d = testDialog(&.{ "[x] notify.js", "[ ] mine.js" });
    d.layout = try testing.allocator.dupe(u8, &.{1});
    o.openDialog(d);
    const t = testDialog(&.{});
    o.openToast(.{ .id = 9, .title = t.title, .body = t.body, .footer = t.footer, .buttons = t.buttons });
    o.setBadge(try testing.allocator.dupe(u8, " plugins 2/2 "));
    try testing.expect(o.badgeHit(59, 0, 60));
    try testing.expect(!o.badgeHit(30, 0, 60));
    try testing.expect(!o.badgeHit(59, 1, 60));
    try testing.expect(o.findDialog(9) != null);

    var out: std.ArrayList(u8) = .{};
    defer out.deinit(testing.allocator);
    try o.render(&out, 60, 24);
    const g = try Grid.create(testing.allocator, 60, 24);
    defer g.destroy(testing.allocator);
    g.feed(out.items);
    const s = try g.snapshot(testing.allocator);
    defer testing.allocator.free(s);
    var it = std.mem.splitScalar(u8, s, '\n');
    const row0 = it.next().?;
    try testing.expect(std.mem.endsWith(u8, row0, "plugins 2/2 "));
    const row1 = it.next().?;
    try testing.expect(std.mem.endsWith(u8, row1, "╮")); // toast's top border, right-aligned
    try testing.expect(std.mem.indexOf(u8, s, "[x] notify.js") != null);
    // Buttons stacked: the two labels sit on different rows.
    var a_row: ?usize = null;
    var b_row: ?usize = null;
    var it2 = std.mem.splitScalar(u8, s, '\n');
    var i: usize = 0;
    while (it2.next()) |l| : (i += 1) {
        if (std.mem.indexOf(u8, l, "notify.js") != null) a_row = i;
        if (std.mem.indexOf(u8, l, "mine.js") != null) b_row = i;
    }
    try testing.expectEqual(a_row.? + 1, b_row.?);

    o.closeById(9);
    try testing.expect(o.toast == null and o.dialog != null);
}

test "eachRow [3,5]: rows are justified to the same width" {
    var o: Overlay = .{ .allocator = testing.allocator };
    defer o.deinit();
    var d = testDialog(&.{ "plan", "norm", "auto", "low", "medium", "high", "xhigh", "max" });
    d.layout = try testing.allocator.dupe(u8, &.{ 3, 5 });
    o.openDialog(d);
    var out: std.ArrayList(u8) = .{};
    defer out.deinit(testing.allocator);
    try o.render(&out, 80, 20);
    const g = try Grid.create(testing.allocator, 80, 20);
    defer g.destroy(testing.allocator);
    g.feed(out.items);
    // Both rows: first cell starts right after "│ ", last one ends right
    // before " │" — same span.
    var first: [2]usize = undefined;
    var last: [2]usize = undefined;
    for ([_][]const u8{ "plan", "low" }, [_][]const u8{ "auto", "max" }, 0..) |l, r, k| {
        var y: usize = 0;
        while (y < 20) : (y += 1) {
            const row = try rowString(g, y);
            defer testing.allocator.free(row);
            if (std.mem.indexOf(u8, row, l) != null and std.mem.indexOf(u8, row, r) != null) {
                first[k] = buttonStart(g, y);
                last[k] = buttonEnd(g, y);
            }
        }
    }
    try testing.expectEqual(first[0], first[1]);
    try testing.expectEqual(last[0], last[1]);
}

fn rowString(g: *Grid, y: usize) ![]u8 {
    const s = try g.snapshot(testing.allocator);
    defer testing.allocator.free(s);
    var it = std.mem.splitScalar(u8, s, '\n');
    var i: usize = 0;
    while (it.next()) |l| : (i += 1) if (i == y) return testing.allocator.dupe(u8, l);
    return testing.allocator.dupe(u8, "");
}

/// First / last column on row y whose cell has a background color (a button).
fn buttonStart(g: *Grid, y: usize) usize {
    for (0..g.term.cols) |x| if (hasBg(g, x, y)) return x;
    return 0;
}

fn buttonEnd(g: *Grid, y: usize) usize {
    var x: usize = g.term.cols;
    while (x > 0) {
        x -= 1;
        if (hasBg(g, x, y)) return x;
    }
    return 0;
}

fn hasBg(g: *Grid, x: usize, y: usize) bool {
    const c = g.term.screens.active.pages.getCell(.{ .active = .{ .x = @intCast(x), .y = @intCast(y) } }) orelse return false;
    return c.style().bg_color != .none;
}

test "eachRow [2,2]: arrows move across rows" {
    var o: Overlay = .{ .allocator = testing.allocator };
    defer o.deinit();
    var d = testDialog(&.{ "model", "effort", "plan", "web" });
    d.layout = try testing.allocator.dupe(u8, &.{ 2, 2 });
    o.openDialog(d);
    const dd = &o.dialog.?;
    var buf: [Dialog.max_rows]Dialog.Span = undefined;
    try testing.expectEqual(@as(usize, 2), dd.rows(&buf).len);

    dd.move(.down);
    try testing.expectEqual(@as(usize, 2), dd.active); // model -> plan
    dd.move(.next);
    try testing.expectEqual(@as(usize, 3), dd.active); // web
    dd.move(.up);
    try testing.expectEqual(@as(usize, 1), dd.active); // effort
    dd.move(.down);
    dd.move(.down); // wraps to the first row
    try testing.expectEqual(@as(usize, 1), dd.active);
}
