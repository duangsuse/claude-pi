//! Interactive mode: `claude-p` with no arguments. Wraps the real `claude`
//! TUI (forced to `/tui fullscreen`) in a raw-mode passthrough. Every byte
//! CC draws goes to the real terminal unmodified and into a ghostty-vt grid
//! mirror; the grid is dumped to ~/claude/-p/scr as plain text each frame.
//!
//! P0 is a pure passthrough: keys go straight to the pty, the real terminal
//! answers CC's DEC queries itself (no terminal.zig fakes here). Hook events
//! (Notification / Stop / SessionStart) are relayed to the node sidecar.
const std = @import("std");
const posix = std.posix;
const zmux = @import("zmux");

const hook = @import("../hook.zig");
const driver = @import("../driver.zig");
const term = @import("term.zig");
const Grid = @import("grid.zig").Grid;
const sidecar_mod = @import("sidecar.zig");

pub const term_mod = term;
pub const grid_mod = @import("grid.zig");
pub const sidecar = sidecar_mod;

const stdin_fd: posix.fd_t = 0;
const stdout_fd: posix.fd_t = 1;

/// Min gap between `scr` dumps. CC can emit hundreds of frames a second
/// while streaming; the file is for debugging and plugins, not a recorder.
const scr_interval_ns: i64 = 30 * std.time.ns_per_ms;

const hook_events = [_][]const u8{ "Notification", "Stop", "SessionStart" };

const Shared = struct {
    allocator: std.mem.Allocator,
    /// Guards `grid` and ordering of stdout writes.
    mutex: std.Thread.Mutex = .{},
    grid: *Grid,
    dirty: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    exited: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    exit_code: std.atomic.Value(u8) = std.atomic.Value(u8).init(0),
};

fn onZmuxEvent(ctx: *anyopaque, event: zmux.native.Event) void {
    const shared: *Shared = @ptrCast(@alignCast(ctx));
    switch (event) {
        .pane_output => |po| {
            shared.mutex.lock();
            defer shared.mutex.unlock();
            term.writeAll(stdout_fd, po.data);
            shared.grid.feed(po.data);
            shared.dirty.store(true, .seq_cst);
        },
        .session_exited => |se| {
            const code: u8 = if (se.exit_code) |c| @truncate(c) else if (se.signal) |s| @truncate(128 + s) else 0;
            shared.exit_code.store(code, .seq_cst);
            shared.exited.store(true, .seq_cst);
        },
        .pane_activity, .pane_bell, .foreground_changed => {},
    }
}

/// `~/claude/-p`, created on demand. Caller frees.
pub fn dataDir(allocator: std.mem.Allocator) ![]u8 {
    const home = posix.getenv("HOME") orelse return error.NoHome;
    const dir = try std.fs.path.join(allocator, &.{ home, "claude", "-p" });
    errdefer allocator.free(dir);
    try std.fs.cwd().makePath(dir);
    return dir;
}

pub const rc_hint =
    \\claude-p: bind Ctrl+P in your shell to open claude-p (run it yourself, nothing was changed):
    \\
    \\  # zsh
    \\  echo 'claude-p-w(){ BUFFER=claude-p; zle accept-line }; zle -N claude-p-w; bindkey "^P" claude-p-w' >> ~/.zshrc
    \\  # bash
    \\  echo 'bind -x '"'"'"\C-p": claude-p'"'"'' >> ~/.bashrc
    \\
    \\Inside claude-p, Ctrl+P opens the settings panel.
    \\
;

const SidecarCtx = struct {
    allocator: std.mem.Allocator,
    session: *zmux.NativeSession,
};

fn onSidecarLine(ctx: *const SidecarCtx, line: []const u8) void {
    const Msg = struct { t: []const u8, data: ?[]const u8 = null };
    const parsed = std.json.parseFromSlice(Msg, ctx.allocator, line, .{ .ignore_unknown_fields = true }) catch return;
    defer parsed.deinit();
    if (std.mem.eql(u8, parsed.value.t, "write")) {
        if (parsed.value.data) |d| ctx.session.writeInput(d) catch {};
    }
}

pub fn run(allocator: std.mem.Allocator) !u8 {
    if (!posix.isatty(stdin_fd) or !posix.isatty(stdout_fd)) {
        term.writeAll(2, "claude-p: interactive mode needs a terminal (pass a prompt for `claude -p` mode)\n");
        return 2;
    }

    const data_dir = try dataDir(allocator);
    defer allocator.free(data_dir);
    const scr_path = try std.fs.path.join(allocator, &.{ data_dir, "scr" });
    defer allocator.free(scr_path);
    const installed_path = try std.fs.path.join(allocator, &.{ data_dir, ".installed" });
    defer allocator.free(installed_path);
    const first_run = blk: {
        std.fs.cwd().access(installed_path, .{}) catch break :blk true;
        break :blk false;
    };

    var harness = try hook.createWith(allocator, .{ .events = &hook_events, .fullscreen = true });
    defer harness.deinit();

    // Open the FIFO read end (plus a dummy writer so it never reports HUP
    // between hook invocations) BEFORE spawning claude.
    const fifo_z = try allocator.dupeZ(u8, harness.fifo_path);
    defer allocator.free(fifo_z);
    const fifo_fd = try posix.openZ(fifo_z, .{ .ACCMODE = .RDONLY, .NONBLOCK = true, .CLOEXEC = true }, 0);
    defer posix.close(fifo_fd);
    const fifo_keep = try posix.openZ(fifo_z, .{ .ACCMODE = .WRONLY, .NONBLOCK = true, .CLOEXEC = true }, 0);
    defer posix.close(fifo_keep);

    const claude_bin = posix.getenv("CLAUDE_P_CLAUDE") orelse "claude";
    const argv = [_][]const u8{ claude_bin, "--settings", harness.settings_json };
    const quoted = try driver.shellQuoteArgv(allocator, &argv);
    defer allocator.free(quoted);
    const shell_cmd = try std.fmt.allocPrint(allocator, "exec {s}", .{quoted});
    defer allocator.free(shell_cmd);

    var env_list: std.ArrayList([]const u8) = .{};
    defer {
        for (env_list.items) |s| allocator.free(s);
        env_list.deinit(allocator);
    }
    var env_map = try std.process.getEnvMap(allocator);
    defer env_map.deinit();
    var it = env_map.iterator();
    while (it.next()) |e| {
        try env_list.append(allocator, try std.fmt.allocPrint(allocator, "{s}={s}", .{ e.key_ptr.*, e.value_ptr.* }));
    }
    try env_list.append(allocator, try std.fmt.allocPrint(allocator, "CLAUDE_P_FIFO={s}", .{harness.fifo_path}));

    var sz = term.size(stdout_fd);
    const winch_fd = try term.watchWinch();

    const grid = try Grid.create(allocator, sz.cols, sz.rows);
    defer grid.destroy(allocator);
    var shared: Shared = .{ .allocator = allocator, .grid = grid };

    const orig_termios = try term.enterRaw(stdin_fd);
    defer term.restore(stdin_fd, orig_termios);

    const session = zmux.NativeSession.create(allocator, .{
        .id = "claude-p",
        .shell = "/bin/sh",
        .command = shell_cmd,
        .env = env_list.items,
        .rows = sz.rows,
        .cols = sz.cols,
        .event_sink = .{ .context = @ptrCast(&shared), .emit = onZmuxEvent },
    }) catch {
        term.restore(stdin_fd, orig_termios);
        term.writeAll(2, "claude-p: failed to spawn claude\n");
        return 2;
    };
    defer session.destroy();

    var side: ?sidecar_mod.Sidecar = null;
    if (sidecar_mod.findHost(allocator)) |host_path| {
        defer allocator.free(host_path);
        side = sidecar_mod.spawn(allocator, host_path) catch null;
    }
    defer if (side) |*s| s.deinit();
    // After both children are forked: a dead sidecar must not kill us.
    term.ignoreSigpipe();
    if (side) |*s| s.send(.{ .t = "init", .dataDir = data_dir, .scr = scr_path, .cols = sz.cols, .rows = sz.rows, .pid = std.c.getpid() });
    const side_ctx: SidecarCtx = .{ .allocator = allocator, .session = session };

    var fifo_buf: std.ArrayList(u8) = .{};
    defer fifo_buf.deinit(allocator);
    var last_scr_ns: i64 = 0;
    var inbuf: [4096]u8 = undefined;

    while (!shared.exited.load(.seq_cst)) {
        // zmux flips to .terminated on pty EOF but only emits session_exited
        // once someone reaps; reap here so the exit code reaches us.
        if (session.state() == .terminated) {
            var tries: usize = 0;
            while (!shared.exited.load(.seq_cst) and tries < 50) : (tries += 1) {
                if (session.handle.reapExited() != null) break;
                std.Thread.sleep(10 * std.time.ns_per_ms);
            }
            break;
        }
        var fds = [_]posix.pollfd{
            .{ .fd = stdin_fd, .events = posix.POLL.IN, .revents = 0 },
            .{ .fd = winch_fd, .events = posix.POLL.IN, .revents = 0 },
            .{ .fd = fifo_fd, .events = posix.POLL.IN, .revents = 0 },
            .{ .fd = if (side) |*s| (if (s.alive) s.stdoutFd() else -1) else -1, .events = posix.POLL.IN, .revents = 0 },
        };
        _ = posix.poll(&fds, 20) catch 0;

        if (fds[0].revents & (posix.POLL.IN | posix.POLL.HUP) != 0) {
            const n = posix.read(stdin_fd, &inbuf) catch 0;
            if (n == 0) break;
            session.writeInput(inbuf[0..n]) catch {};
        }

        if (fds[1].revents & posix.POLL.IN != 0) {
            term.drain(winch_fd);
            const new_sz = term.size(stdout_fd);
            if (new_sz.cols != sz.cols or new_sz.rows != sz.rows) {
                sz = new_sz;
                shared.mutex.lock();
                grid.resize(allocator, sz.cols, sz.rows);
                shared.mutex.unlock();
                session.resize(sz.cols, sz.rows) catch {};
                if (side) |*s| s.send(.{ .t = "resize", .cols = sz.cols, .rows = sz.rows });
            }
        }

        if (fds[2].revents & posix.POLL.IN != 0) {
            var buf: [4096]u8 = undefined;
            while (true) {
                const n = posix.read(fifo_fd, &buf) catch break;
                if (n == 0) break;
                try fifo_buf.appendSlice(allocator, buf[0..n]);
            }
            while (std.mem.indexOfScalar(u8, fifo_buf.items, '\n')) |nl| {
                if (hook.parseLine(fifo_buf.items[0 .. nl + 1])) |ln| {
                    const tab = std.mem.indexOfScalar(u8, fifo_buf.items[0..nl], '\t').?;
                    if (side) |*s| s.sendHook(fifo_buf.items[0..tab], ln.payload);
                }
                const rest = fifo_buf.items.len - (nl + 1);
                std.mem.copyForwards(u8, fifo_buf.items[0..rest], fifo_buf.items[nl + 1 ..]);
                fifo_buf.shrinkRetainingCapacity(rest);
            }
        }

        if (fds[3].revents & (posix.POLL.IN | posix.POLL.HUP) != 0) {
            if (side) |*s| _ = s.pump(&side_ctx, onSidecarLine);
        }

        const now: i64 = @intCast(std.time.nanoTimestamp());
        if (shared.dirty.load(.seq_cst) and now - last_scr_ns >= scr_interval_ns) {
            last_scr_ns = now;
            writeScr(&shared, scr_path);
        }
    }
    if (shared.dirty.load(.seq_cst)) writeScr(&shared, scr_path);

    // If CC died without leaving the alt screen, don't strand the user there.
    shared.mutex.lock();
    const stuck_alt = grid.onAltScreen();
    shared.mutex.unlock();
    if (stuck_alt) term.writeAll(stdout_fd, "\x1b[?1049l");
    term.writeAll(stdout_fd, "\x1b[?25h");
    term.restore(stdin_fd, orig_termios);

    if (first_run) {
        term.writeAll(1, rc_hint);
        if (std.fs.cwd().createFile(installed_path, .{})) |f| f.close() else |_| {}
    }
    return shared.exit_code.load(.seq_cst);
}

fn writeScr(shared: *Shared, scr_path: []const u8) void {
    shared.mutex.lock();
    shared.dirty.store(false, .seq_cst);
    const text = shared.grid.snapshot(shared.allocator) catch {
        shared.mutex.unlock();
        return;
    };
    shared.mutex.unlock();
    defer shared.allocator.free(text);
    // Write-then-rename so readers never see a half-written frame.
    var tmp_buf: [std.fs.max_path_bytes]u8 = undefined;
    const tmp = std.fmt.bufPrint(&tmp_buf, "{s}.tmp", .{scr_path}) catch return;
    const f = std.fs.cwd().createFile(tmp, .{}) catch return;
    f.writeAll(text) catch {};
    f.close();
    std.fs.cwd().rename(tmp, scr_path) catch {};
}

test {
    std.testing.refAllDecls(grid_mod);
}
