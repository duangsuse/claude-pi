//! Interactive mode: `claude-p` with no arguments. Wraps the real `claude`
//! TUI (forced to `/tui fullscreen`) in a raw-mode passthrough. Every byte
//! CC draws goes to the real terminal unmodified and into a ghostty-vt grid
//! mirror; the grid is dumped to ~/claude/-p/scr as plain text each frame.
//!
//! Keys go straight to the pty except the few `Keys` intercepts (Tab prefix
//! completion, Ctrl+C partial clear, Enter on a bare path); the real
//! terminal answers CC's DEC queries itself (no terminal.zig fakes here).
//! Hook events (Notification / Stop / SessionStart) are relayed to the node
//! sidecar.
const std = @import("std");
const posix = std.posix;
const zmux = @import("zmux");

const hook = @import("../hook.zig");
const driver = @import("../driver.zig");
const term = @import("term.zig");
const Grid = @import("grid.zig").Grid;
const sidecar_mod = @import("sidecar.zig");
const screen = @import("screen.zig");
const input = @import("input.zig");
const steps = @import("steps.zig");
const fzf = @import("fzf.zig");

pub const term_mod = term;
pub const grid_mod = @import("grid.zig");
pub const sidecar = sidecar_mod;

const stdin_fd: posix.fd_t = 0;
const stdout_fd: posix.fd_t = 1;

/// Min gap between `scr` dumps. CC can emit hundreds of frames a second
/// while streaming; the file is for debugging and plugins, not a recorder.
const scr_interval_ns: i64 = 30 * std.time.ns_per_ms;

const hook_events = [_][]const u8{ "Notification", "Stop", "SessionStart" };

/// Quiet gap before a scripted command line (see Keys.submit); same figure
/// as driver.ink_enter_debounce_ms.
const enter_gap_ms: u32 = 120;

const Shared = struct {
    allocator: std.mem.Allocator,
    /// Guards `grid`, `paused` and ordering of stdout writes.
    mutex: std.Thread.Mutex = .{},
    grid: *Grid,
    /// Something else (fzf) owns the terminal: keep feeding the grid but
    /// don't write CC's output to stdout. Repaint from the grid on resume.
    paused: bool = false,
    last_output_ns: std.atomic.Value(i64) = std.atomic.Value(i64).init(0),
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
            if (!shared.paused) term.writeAll(stdout_fd, po.data);
            shared.grid.feed(po.data);
            shared.dirty.store(true, .seq_cst);
            shared.last_output_ns.store(@intCast(std.time.nanoTimestamp()), .seq_cst);
        },
        .session_exited => |se| {
            const code: u8 = if (se.exit_code) |c| @truncate(c) else if (se.signal) |s| @truncate(128 + s) else 0;
            shared.exit_code.store(code, .seq_cst);
            shared.exited.store(true, .seq_cst);
        },
        .pane_activity, .pane_bell, .foreground_changed => {},
    }
}

/// `~/claude/-p` ($CLAUDE_P_DIR overrides, e.g. for tests running next to
/// a real session), created on demand. Caller frees.
pub fn dataDir(allocator: std.mem.Allocator) ![]u8 {
    if (posix.getenv("CLAUDE_P_DIR")) |d| {
        try std.fs.cwd().makePath(d);
        return allocator.dupe(u8, d);
    }
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

/// The keys interactive mode intercepts, and the state they need. Also the
/// `env` for steps.Runner.
const Keys = struct {
    allocator: std.mem.Allocator,
    shared: *Shared,
    session: *zmux.NativeSession,
    runner: steps.Runner,
    /// Where claude was started; CC's @ suggestions are relative to it.
    project_root: []u8,
    /// CC's current directory, from hook payloads and our own `! cd`.
    cwd: []u8,
    home: []const u8,
    /// Directories CC may cd into without resetting: the root + /add-dir'd.
    allowed: std.ArrayList([]u8) = .{},
    /// `pi.arg.fzf` (owned once a plugin sets it).
    fzf_args: []const u8 = fzf.default_args,
    fzf_args_owned: bool = false,

    fn init(allocator: std.mem.Allocator, shared: *Shared, session: *zmux.NativeSession) !Keys {
        const root = try std.process.getCwdAlloc(allocator);
        errdefer allocator.free(root);
        var k: Keys = .{
            .allocator = allocator,
            .shared = shared,
            .session = session,
            .runner = .{ .allocator = allocator },
            .project_root = root,
            .cwd = try allocator.dupe(u8, root),
            .home = posix.getenv("HOME") orelse "/",
        };
        try k.allowed.append(allocator, try allocator.dupe(u8, root));
        return k;
    }

    fn deinit(self: *Keys) void {
        self.runner.deinit();
        self.allocator.free(self.project_root);
        self.allocator.free(self.cwd);
        for (self.allowed.items) |a| self.allocator.free(a);
        self.allowed.deinit(self.allocator);
        if (self.fzf_args_owned) self.allocator.free(self.fzf_args);
    }

    fn setFzfArgs(self: *Keys, args: []const u8) void {
        const copy = self.allocator.dupe(u8, args) catch return;
        if (self.fzf_args_owned) self.allocator.free(self.fzf_args);
        self.fzf_args = copy;
        self.fzf_args_owned = true;
    }

    fn setCwd(self: *Keys, dir: []const u8) void {
        const copy = self.allocator.dupe(u8, dir) catch return;
        self.allocator.free(self.cwd);
        self.cwd = copy;
    }

    fn box(self: *Keys) ?screen.Box {
        self.shared.mutex.lock();
        defer self.shared.mutex.unlock();
        return screen.inputBox(self.allocator, &self.shared.grid.term) catch null;
    }

    /// Returns true when `bytes` was handled here instead of going to CC.
    fn handle(self: *Keys, bytes: []const u8) bool {
        if (self.runner.active()) return false;
        return switch (input.classify(bytes)) {
            .tab => self.onTab(),
            .ctrl_c => self.onCtrlC(),
            .enter => self.onEnter(),
            .other => false,
        };
    }

    /// `./x` / `/~/x` + Tab: fzf on the real tty, then swap the token for
    /// an @-mention.
    fn onTab(self: *Keys) bool {
        var b = self.box() orelse return false;
        defer b.deinit(self.allocator);
        if (b.empty) return false;
        const tok = b.tokenBeforeCursor() orelse return false;
        const comp = input.completion(tok) orelse return false;
        const dir = if (comp.root == .cwd) self.cwd else self.home;

        self.shared.mutex.lock();
        self.shared.paused = true;
        self.shared.mutex.unlock();
        term.writeAll(stdout_fd, fzf.prelude);
        const picked = fzf.pickPath(self.allocator, dir, comp.query, self.fzf_args) catch null;
        defer if (picked) |p| self.allocator.free(p);
        self.shared.mutex.lock();
        if (self.shared.grid.redraw(self.allocator)) |frame| {
            term.writeAll(stdout_fd, frame);
            self.allocator.free(frame);
        } else |_| {}
        self.shared.paused = false;
        self.shared.mutex.unlock();

        const path = picked orelse return true;
        var out: std.ArrayList(u8) = .{};
        defer out.deinit(self.allocator);
        const n = std.unicode.utf8CountCodepoints(tok) catch tok.len;
        for (0..n) |_| out.appendSlice(self.allocator, input.backspace) catch return true;
        const m = input.mention(self.allocator, b.mode, path, self.project_root) catch return true;
        defer self.allocator.free(m);
        out.appendSlice(self.allocator, m) catch return true;
        self.write(out.items);
        return true;
    }

    /// Ctrl+C with text: clear the caret's row and below, keeping the
    /// newline before it (caret ends on a fresh line). Empty: CC's own.
    fn onCtrlC(self: *Keys) bool {
        var b = self.box() orelse return false;
        defer b.deinit(self.allocator);
        const plan = (input.ctrlCPlan(self.allocator, &b) catch null) orelse return false;
        defer self.allocator.free(plan);
        self.write(plan);
        return true;
    }

    /// Enter on a single-line `/~/path`: mkdir -p, /add-dir if outside the
    /// allowed dirs, /clear, `! cd`, interrupt the turn CC starts after it.
    /// /clear goes first because it resets CC's cwd to the start directory.
    fn onEnter(self: *Keys) bool {
        var b = self.box() orelse return false;
        defer b.deinit(self.allocator);
        const target = (input.cdTarget(self.allocator, &b, self.home) catch null) orelse return false;
        defer self.allocator.free(target);
        std.fs.cwd().makePath(target) catch return false;
        self.queueCd(&b, target) catch {};
        return true;
    }

    fn queueCd(self: *Keys, b: *const screen.Box, target: []const u8) !void {
        const a = self.allocator;
        if (try input.ctrlCPlan(a, b)) |clear| {
            defer a.free(clear);
            try self.runner.write(clear);
            try self.runner.push(.{ .settle = 80 });
        }
        if (!input.isAllowed(target, self.allowed.items)) {
            const cmd = try std.fmt.allocPrint(a, "/add-dir {s}", .{target});
            defer a.free(cmd);
            try self.submit(cmd);
            try self.runner.push(.{ .settle = 300 });
            try self.runner.push(.{ .confirm_if = "Yes, for this session" });
            try self.runner.push(.idle);
            try self.allowed.append(a, try a.dupe(u8, target));
        }
        try self.submit("/clear");
        try self.runner.push(.idle);
        try self.runner.write("!");
        try self.runner.push(.{ .settle = 150 });
        const q = try input.shellQuote(a, target);
        defer a.free(q);
        // Trailing space: no path token under the caret, so CC's path
        // suggestions don't pop up and take the Enter.
        const cd = try std.fmt.allocPrint(a, "cd {s} ", .{q});
        defer a.free(cd);
        try self.submit(cd);
        try self.runner.push(.interrupt);
        // Esc can hand the command back to the box; don't leave it there.
        try self.runner.push(.clear_box);
        self.setCwd(target);
    }

    /// Type `text` + Enter as one write, after a quiet gap. Text and Enter
    /// split up lets CC's path/command suggestions pop up in between and
    /// swallow the Enter; a burst glued to the previous write is taken as a
    /// paste (Enter becomes a newline). Both seen against real CC. If a
    /// popup still took the Enter, the text is left in the box: Enter again.
    fn submit(self: *Keys, text: []const u8) !void {
        try self.runner.push(.{ .settle = enter_gap_ms });
        const line = try std.fmt.allocPrint(self.allocator, "{s}\r", .{text});
        defer self.allocator.free(line);
        try self.runner.write(line);
        try self.runner.push(.{ .settle = 250 });
        try self.runner.push(.enter_if_text);
    }

    // ---- steps.Runner env ----

    pub fn write(self: *Keys, bytes: []const u8) void {
        self.session.writeInput(bytes) catch {};
    }

    pub fn quietMs(self: *Keys) i64 {
        const last = self.shared.last_output_ns.load(.seq_cst);
        const now: i64 = @intCast(std.time.nanoTimestamp());
        return @divTrunc(now - last, std.time.ns_per_ms);
    }

    pub fn hasBox(self: *Keys) bool {
        var b = self.box() orelse return false;
        b.deinit(self.allocator);
        return true;
    }

    pub fn busy(self: *Keys) bool {
        self.shared.mutex.lock();
        defer self.shared.mutex.unlock();
        return screen.isBusy(self.allocator, &self.shared.grid.term);
    }

    pub fn commandRunning(self: *Keys) bool {
        self.shared.mutex.lock();
        defer self.shared.mutex.unlock();
        return screen.commandRunning(self.allocator, &self.shared.grid.term);
    }

    pub fn boxHasText(self: *Keys) bool {
        var b = self.box() orelse return false;
        defer b.deinit(self.allocator);
        return !b.empty;
    }

    pub fn clearBox(self: *Keys) void {
        var b = self.box() orelse return;
        defer b.deinit(self.allocator);
        const plan = (input.clearAllPlan(self.allocator, &b) catch null) orelse return;
        defer self.allocator.free(plan);
        self.write(plan);
    }

    pub fn contains(self: *Keys, text: []const u8) bool {
        self.shared.mutex.lock();
        defer self.shared.mutex.unlock();
        return screen.contains(self.allocator, &self.shared.grid.term, text);
    }

};

/// Messages from the sidecar:
///   {"t":"submit","data":s}  pi`s`: replace the box text with s + Enter
///   {"t":"buffer","data":s}  pi.BUFFER = s: replace the input box text
///   {"t":"write","data":s}   raw bytes to the pty
///   {"t":"arg","key":k,"value":v}  pi.arg.k = v (k: fzf)
fn onSidecarLine(keys: *Keys, line: []const u8) void {
    const Msg = struct { t: []const u8, data: ?[]const u8 = null, key: ?[]const u8 = null, value: ?[]const u8 = null };
    const parsed = std.json.parseFromSlice(Msg, keys.allocator, line, .{ .ignore_unknown_fields = true }) catch return;
    defer parsed.deinit();
    const m = parsed.value;
    const eql = std.mem.eql;
    if (eql(u8, m.t, "write")) {
        if (m.data) |d| keys.write(d);
    } else if (eql(u8, m.t, "submit")) {
        // Replace whatever draft is in the box, then Enter: appending a
        // command to a draft would send the mix as a prompt.
        if (m.data) |d| {
            keys.runner.push(.clear_box) catch {};
            keys.submit(d) catch {};
        }
    } else if (eql(u8, m.t, "buffer")) {
        if (m.data) |d| {
            keys.runner.push(.clear_box) catch {};
            keys.runner.write(d) catch {};
        }
    } else if (eql(u8, m.t, "arg")) {
        const k = m.key orelse return;
        if (eql(u8, k, "fzf")) keys.setFzfArgs(m.value orelse "");
    }
}

/// Whether `argv` asks for interactive mode: no arguments, or only the
/// resume/continue flags (`-r [id]`, `--resume [id]`, `-c`, `--continue`),
/// which are handed to claude as-is. Anything else (a prompt, other flags)
/// is `claude -p` mode. Callers also require stdin to be a terminal, so
/// `echo hi | claude-p` keeps reading the prompt from stdin.
pub fn wantsInteractive(argv: []const []const u8) bool {
    var i: usize = 0;
    while (i < argv.len) : (i += 1) {
        const a = argv[i];
        if (std.mem.eql(u8, a, "-c") or std.mem.eql(u8, a, "--continue")) continue;
        if (std.mem.eql(u8, a, "-r") or std.mem.eql(u8, a, "--resume")) {
            if (i + 1 < argv.len and !std.mem.startsWith(u8, argv[i + 1], "-")) i += 1;
            continue;
        }
        return false;
    }
    return true;
}

/// `extra` is appended to the claude command line (see wantsInteractive).
pub fn run(allocator: std.mem.Allocator, extra: []const []const u8) !u8 {
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
    var argv: std.ArrayList([]const u8) = .{};
    defer argv.deinit(allocator);
    try argv.appendSlice(allocator, &.{ claude_bin, "--settings", harness.settings_json });
    try argv.appendSlice(allocator, extra);
    const quoted = try driver.shellQuoteArgv(allocator, argv.items);
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
    if (side) |*s| s.send(.{
        .t = "init",
        .dataDir = data_dir,
        .scr = scr_path,
        .cols = sz.cols,
        .rows = sz.rows,
        .pid = std.c.getpid(),
        .arg = .{ .fzf = fzf.default_args },
    });

    var keys = try Keys.init(allocator, &shared, session);
    defer keys.deinit();

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
            if (!keys.handle(inbuf[0..n])) session.writeInput(inbuf[0..n]) catch {};
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
                    if (hook.extractCwd(allocator, ln.payload) catch null) |c| {
                        defer allocator.free(c);
                        keys.setCwd(c);
                    }
                }
                const rest = fifo_buf.items.len - (nl + 1);
                std.mem.copyForwards(u8, fifo_buf.items[0..rest], fifo_buf.items[nl + 1 ..]);
                fifo_buf.shrinkRetainingCapacity(rest);
            }
        }

        if (fds[3].revents & (posix.POLL.IN | posix.POLL.HUP) != 0) {
            if (side) |*s| _ = s.pump(&keys, onSidecarLine);
        }

        const now: i64 = @intCast(std.time.nanoTimestamp());
        keys.runner.tick(&keys, @divTrunc(now, std.time.ns_per_ms));
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

test "wantsInteractive" {
    const t = std.testing;
    try t.expect(wantsInteractive(&.{}));
    try t.expect(wantsInteractive(&.{"-r"}));
    try t.expect(wantsInteractive(&.{ "-r", "abc" }));
    try t.expect(wantsInteractive(&.{ "--resume", "abc", "-c" }));
    try t.expect(wantsInteractive(&.{"--continue"}));
    try t.expect(!wantsInteractive(&.{ "-r", "abc", "prompt" }));
    try t.expect(!wantsInteractive(&.{"hello"}));
    try t.expect(!wantsInteractive(&.{ ".json", "hi" }));
    try t.expect(!wantsInteractive(&.{"--help"}));
}

test {
    std.testing.refAllDecls(grid_mod);
    std.testing.refAllDecls(@import("screen.zig"));
    std.testing.refAllDecls(@import("input.zig"));
    std.testing.refAllDecls(@import("steps.zig"));
}
