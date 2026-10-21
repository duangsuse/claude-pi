//! A tiny queue of pty writes and waits, driven from the main poll loop so
//! multi-step flows (path → /add-dir → ! cd → /clear) never block it. Each
//! wait has a cap: if CC never gets there we move on rather than hang.
const std = @import("std");

pub const Step = union(enum) {
    /// Bytes for the pty (owned by the runner).
    write: []u8,
    /// Wait this many ms, and until CC's output has been quiet that long.
    settle: u32,
    /// Wait until the input box is back, CC isn't busy, and output is quiet.
    idle,
    /// Press Enter if the screen shows this text (e.g. a confirm dialog).
    confirm_if: []const u8,
    /// Press Esc if CC is running a turn.
    esc_if_busy,
    /// After a `!` command CC starts a model turn: Esc it once it shows up,
    /// done when CC is idle and has been quiet for a while. Never while the
    /// command itself is still running: CC counts that as busy too, and Esc
    /// there cancels the command and puts it back in the input box.
    interrupt,
    /// Empty the input box if it has text (e.g. CC restored something).
    clear_box,
    /// Press Enter if the box still holds text: a suggestion popup took the
    /// first one.
    enter_if_text,
    /// Tell the sidecar that everything queued before this ran (resolves
    /// the promise pi`…` returned).
    done: u32,
};

const settle_cap_ms: i64 = 3000;
const idle_cap_ms: i64 = 10_000;
const idle_quiet_ms: i64 = 150;
/// Long enough that the gap between the bash run and the turn starting
/// isn't mistaken for idle (the spinner redraws every ~100 ms).
const interrupt_quiet_ms: i64 = 600;

pub const Runner = struct {
    allocator: std.mem.Allocator,
    queue: std.ArrayList(Step) = .{},
    /// When the head step started waiting (ms); null = not started.
    started_ms: ?i64 = null,
    /// `.interrupt` already pressed Esc.
    esc_sent: bool = false,

    pub fn deinit(self: *Runner) void {
        for (self.queue.items) |s| self.free(s);
        self.queue.deinit(self.allocator);
    }

    fn free(self: *Runner, s: Step) void {
        if (s == .write) self.allocator.free(s.write);
    }

    pub fn active(self: *const Runner) bool {
        return self.queue.items.len > 0;
    }

    pub fn push(self: *Runner, step: Step) !void {
        try self.queue.append(self.allocator, step);
    }

    pub fn write(self: *Runner, bytes: []const u8) !void {
        try self.push(.{ .write = try self.allocator.dupe(u8, bytes) });
    }

    /// Run as many steps as are ready. `env` provides:
    ///   write([]const u8) void, quietMs() i64, hasBox() bool, busy() bool,
    ///   commandRunning() bool, contains([]const u8) bool, clearBox() void,
    ///   boxHasText() bool, done(u32) void
    pub fn tick(self: *Runner, env: anytype, now_ms: i64) void {
        while (self.queue.items.len > 0) {
            const head = self.queue.items[0];
            const start = self.started_ms orelse blk: {
                self.started_ms = now_ms;
                break :blk now_ms;
            };
            const waited = now_ms - start;
            const done = switch (head) {
                .write => |b| blk: {
                    env.write(b);
                    break :blk true;
                },
                // Quiet time alone could predate the step (CC hasn't reacted
                // to our last write yet), so every wait also needs `waited`.
                .settle => |ms| (waited >= ms and env.quietMs() >= ms) or waited >= settle_cap_ms,
                .idle => (waited >= idle_quiet_ms and env.hasBox() and !env.busy() and env.quietMs() >= idle_quiet_ms) or waited >= idle_cap_ms,
                .confirm_if => |text| blk: {
                    if (env.contains(text)) env.write("\r");
                    break :blk true;
                },
                .esc_if_busy => blk: {
                    if (env.busy()) env.write("\x1b");
                    break :blk true;
                },
                .clear_box => blk: {
                    env.clearBox();
                    break :blk true;
                },
                .enter_if_text => blk: {
                    if (env.boxHasText()) env.write("\r");
                    break :blk true;
                },
                .done => |id| blk: {
                    env.done(id);
                    break :blk true;
                },
                .interrupt => blk: {
                    if (waited >= idle_cap_ms) break :blk true;
                    if (env.commandRunning()) break :blk false;
                    if (env.busy()) {
                        if (!self.esc_sent) env.write("\x1b");
                        self.esc_sent = true;
                        break :blk false;
                    }
                    break :blk waited >= interrupt_quiet_ms and env.quietMs() >= interrupt_quiet_ms;
                },
            };
            if (!done) return;
            self.free(head);
            _ = self.queue.orderedRemove(0);
            self.started_ms = null;
            self.esc_sent = false;
        }
    }
};

// -------- tests --------

const testing = std.testing;

const FakeEnv = struct {
    out: std.ArrayList(u8) = .{},
    quiet: i64 = 0,
    box: bool = true,
    is_busy: bool = false,
    running: bool = false,
    text: []const u8 = "",

    fn write(self: *FakeEnv, b: []const u8) void {
        self.out.appendSlice(testing.allocator, b) catch {};
    }
    fn quietMs(self: *FakeEnv) i64 {
        return self.quiet;
    }
    fn hasBox(self: *FakeEnv) bool {
        return self.box;
    }
    fn busy(self: *FakeEnv) bool {
        return self.is_busy;
    }
    fn commandRunning(self: *FakeEnv) bool {
        return self.running;
    }
    fn clearBox(self: *FakeEnv) void {
        self.write("<clear>");
    }
    fn boxHasText(_: *FakeEnv) bool {
        return false;
    }
    fn done(self: *FakeEnv, id: u32) void {
        self.out.print(testing.allocator, "<done {d}>", .{id}) catch {};
    }
    fn contains(self: *FakeEnv, t: []const u8) bool {
        return std.mem.indexOf(u8, self.text, t) != null;
    }
};

test "runner waits on settle/idle and runs conditionals" {
    var r: Runner = .{ .allocator = testing.allocator };
    defer r.deinit();
    var env: FakeEnv = .{};
    defer env.out.deinit(testing.allocator);

    try r.write("/add-dir x\r");
    try r.push(.{ .settle = 200 });
    try r.push(.{ .confirm_if = "Yes, for this session" });
    try r.push(.idle);
    try r.push(.esc_if_busy);
    try r.write("/clear\r");

    r.tick(&env, 0);
    try testing.expectEqualStrings("/add-dir x\r", env.out.items);
    try testing.expect(r.active());

    env.quiet = 250;
    env.text = "1. Yes, for this session";
    env.box = false;
    r.tick(&env, 100);
    try testing.expectEqualStrings("/add-dir x\r", env.out.items);
    r.tick(&env, 300);
    try testing.expectEqualStrings("/add-dir x\r\r", env.out.items);

    // idle blocks until the box is back
    r.tick(&env, 600);
    try testing.expectEqualStrings("/add-dir x\r\r", env.out.items);
    env.box = true;
    env.is_busy = false;
    r.tick(&env, 700);
    try testing.expectEqualStrings("/add-dir x\r\r/clear\r", env.out.items);
    try testing.expect(!r.active());
}

test "interrupt presses Esc once while busy, then waits for quiet" {
    var r: Runner = .{ .allocator = testing.allocator };
    defer r.deinit();
    var env: FakeEnv = .{ .is_busy = true, .running = true };
    defer env.out.deinit(testing.allocator);
    try r.push(.interrupt);
    try r.write("/clear\r");
    // `! cd` still running: busy, but no Esc yet.
    r.tick(&env, 0);
    try testing.expectEqualStrings("", env.out.items);
    env.running = false;
    r.tick(&env, 50);
    r.tick(&env, 100);
    try testing.expectEqualStrings("\x1b", env.out.items);
    env.is_busy = false;
    env.quiet = 100;
    r.tick(&env, 200);
    try testing.expectEqualStrings("\x1b", env.out.items);
    env.quiet = 700;
    r.tick(&env, 900);
    try testing.expectEqualStrings("\x1b/clear\r", env.out.items);
}

test "waits give up at their cap" {
    var r: Runner = .{ .allocator = testing.allocator };
    defer r.deinit();
    var env: FakeEnv = .{ .box = false };
    defer env.out.deinit(testing.allocator);
    try r.push(.idle);
    try r.write("x");
    r.tick(&env, 0);
    r.tick(&env, 5000);
    try testing.expectEqualStrings("", env.out.items);
    r.tick(&env, 10_001);
    try testing.expectEqualStrings("x", env.out.items);
}
