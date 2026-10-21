//! Interactive mode: `claude-p` with no arguments. Wraps the real `claude`
//! TUI (forced to `/tui fullscreen`) in a raw-mode passthrough. Every byte
//! CC draws goes to the real terminal unmodified and into a ghostty-vt grid
//! mirror; the grid is dumped to ~/claude/-p/scr as plain text each frame
//! while that file exists (opt-in: touch it; removed on exit).
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
const overlay_mod = @import("overlay.zig");
const convo = @import("convo.zig");

pub const term_mod = term;
pub const grid_mod = @import("grid.zig");
pub const sidecar = sidecar_mod;

const stdin_fd: posix.fd_t = 0;
const stdout_fd: posix.fd_t = 1;

/// Min gap between `scr` dumps. CC can emit hundreds of frames a second
/// while streaming; the file is for debugging and plugins, not a recorder.
const scr_interval_ns: i64 = 30 * std.time.ns_per_ms;

/// While the wheel scrolls (a wheel report less than `wheel_window_ns` ago),
/// the TUI shows through untouched: its frames go out bare, and non-modal
/// overlays (badge, toast, paints) come back once the wheel has stopped
/// and output has been quiet for `overlay_settle_ns`.
const wheel_window_ns: i64 = 150 * std.time.ns_per_ms;
const overlay_settle_ns: i64 = 40 * std.time.ns_per_ms;
/// Wheel notches per PgUp / PgDn (pi.arg.whlSpeed; 0, the default: the
/// wheel goes to the TUI as is), and the pause after which a partial count
/// is dropped.
const default_wheel_speed: u32 = 0;
const wheel_reset_ns: i64 = 500 * std.time.ns_per_ms;
/// Two plain left clicks this close (time, cells) page the way the wheel
/// last went.
const double_click_ns: i64 = 400 * std.time.ns_per_ms;

const hook_events = [_][]const u8{ "Notification", "Stop", "SessionStart" };

/// CC exiting within this long after a forwarded Ctrl+C counts as "quit
/// with Ctrl+C" (the second press of CC's press-twice-to-exit).
const ctrl_c_exit_window_ns: i64 = 3 * std.time.ns_per_s;

/// How long a hooked key waits for the plugins' verdict before the default
/// action goes ahead anyway.
const key_hook_wait_ms: i64 = 80;

/// Quiet gap before a scripted command line (see Keys.submit); same figure
/// as driver.ink_enter_debounce_ms.
const enter_gap_ms: u32 = 120;

const Shared = struct {
    allocator: std.mem.Allocator,
    /// Guards `grid`, `overlay`, `paused` and ordering of stdout writes.
    mutex: std.Thread.Mutex = .{},
    grid: *Grid,
    overlay: overlay_mod.Overlay,
    /// Something else (fzf) owns the terminal: keep feeding the grid but
    /// don't write CC's output to stdout. Repaint from the grid on resume.
    paused: bool = false,
    last_output_ns: std.atomic.Value(i64) = std.atomic.Value(i64).init(0),
    dirty: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    /// Last wheel report from the user (see wheel_window_ns).
    wheel_ns: std.atomic.Value(i64) = std.atomic.Value(i64).init(0),
    /// A frame went out without the overlays on top (mutex held to touch).
    overlay_stale: bool = false,
    exited: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    exit_code: std.atomic.Value(u8) = std.atomic.Value(u8).init(0),

    /// Forward a CC chunk to the terminal (mutex held, grid already fed).
    /// With an overlay up, the chunk and a fresh paint of the overlay go out
    /// in one synchronized write, so no frame ever shows CC without it.
    fn emit(self: *Shared, data: []const u8) void {
        if (!self.overlay.active()) return term.writeAll(stdout_fd, data);
        const modal = self.overlay.dialog != null or self.overlay.menu != null;
        if (!modal and @as(i64, @intCast(std.time.nanoTimestamp())) - self.wheel_ns.load(.seq_cst) < wheel_window_ns) {
            self.overlay_stale = true;
            return term.writeAll(stdout_fd, data);
        }
        self.overlay_stale = false;
        var out: std.ArrayList(u8) = .{};
        defer out.deinit(self.allocator);
        self.composeFrame(&out, data, false) catch return term.writeAll(stdout_fd, data);
        term.writeAll(stdout_fd, out.items);
    }

    /// Repaint everything from the grid plus overlays (mutex held): after
    /// an overlay shrank or closed, the cells under it come back exactly.
    fn repaint(self: *Shared) void {
        var out: std.ArrayList(u8) = .{};
        defer out.deinit(self.allocator);
        self.composeFrame(&out, "", true) catch return;
        term.writeAll(stdout_fd, out.items);
    }

    /// Paint just the overlays (mutex held), e.g. a button got focus.
    fn paintOverlay(self: *Shared) void {
        var out: std.ArrayList(u8) = .{};
        defer out.deinit(self.allocator);
        self.composeFrame(&out, "", false) catch return;
        term.writeAll(stdout_fd, out.items);
    }

    fn composeFrame(self: *Shared, out: *std.ArrayList(u8), data: []const u8, full: bool) !void {
        const a = self.allocator;
        try out.appendSlice(a, "\x1b[?2026h");
        try out.appendSlice(a, data);
        if (full) try self.grid.redrawInto(a, out);
        try self.overlay.render(out, self.grid.term.cols, self.grid.term.rows);
        try self.grid.restoreCursor(a, out);
        // CC re-shows its caret every frame; it would blink inside the dialog.
        if (self.overlay.dialog != null) try out.appendSlice(a, "\x1b[?25l");
        try out.appendSlice(a, "\x1b[?2026l");
    }
};

fn onZmuxEvent(ctx: *anyopaque, event: zmux.native.Event) void {
    const shared: *Shared = @ptrCast(@alignCast(ctx));
    switch (event) {
        .pane_output => |po| {
            shared.mutex.lock();
            defer shared.mutex.unlock();
            shared.grid.feed(po.data);
            if (!shared.paused) shared.emit(po.data);
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
    /// Current session's transcript, from hook payloads (deleted on a
    /// Ctrl+C exit).
    transcript: ?[]u8 = null,
    /// For overlay events (dialog buttons, menu picks, focus). Set in run().
    side: ?*sidecar_mod.Sidecar = null,
    /// The sidecar wants a `scr` message per dumped frame (pi.sed / scrcpy).
    scr_subscribed: bool = false,
    /// pi.title pushed the terminal's title (XTWINOPS 22) and owes a pop.
    title_pushed: bool = false,
    /// What plugins registered: `/name` commands, Tab prefixes, hooked
    /// keys (CtrlP, …). Replaced wholesale by the sidecar.
    commands: std.ArrayList([]u8) = .{},
    prefixes: std.ArrayList([]u8) = .{},
    hooked: std.ArrayList([]u8) = .{},
    next_req: u32 = 1,
    /// A plugin completion we're waiting on.
    pending: ?struct { id: u32, token: []u8, prefix_len: usize, mode: screen.Mode } = null,
    /// Answer to the last key-hook question.
    key_reply: ?struct { id: u32, prevent: bool } = null,
    /// `pi.arg.fzf` (owned once a plugin sets it).
    fzf_args: []const u8 = fzf.default_args,
    fzf_args_owned: bool = false,
    /// How the TUI's parts look (pi.arg.border / prompt / bash / busy /
    /// running); CC's by default.
    rules: screen.Rules = .{},
    /// `pi.arg.whlSpeed`: this many wheel notches make one PgUp / PgDn; 0
    /// passes the wheel through.
    wheel_speed: u32 = default_wheel_speed,
    wheel_acc: i32 = 0,
    wheel_last_ns: i64 = 0,
    /// Way the wheel last went: -1 up (history), 1 down.
    wheel_dir: i32 = -1,
    /// The last plain left click (for double clicks), and whether the
    /// release of a click we turned into a page is still to be swallowed.
    click: ?struct { ns: i64, x: u16, y: u16 } = null,
    swallow_release: bool = false,
    /// Strings pi.arg handed us (rules point into them), freed at exit.
    arg_store: std.ArrayList([]u8) = .{},

    fn init(allocator: std.mem.Allocator, shared: *Shared, session: *zmux.NativeSession) !Keys {
        const root = try std.process.getCwdAlloc(allocator);
        errdefer allocator.free(root);
        return .{
            .allocator = allocator,
            .shared = shared,
            .session = session,
            .runner = .{ .allocator = allocator },
            .project_root = root,
            .cwd = try allocator.dupe(u8, root),
            .home = posix.getenv("HOME") orelse "/",
        };
    }

    fn deinit(self: *Keys) void {
        self.runner.deinit();
        self.allocator.free(self.project_root);
        self.allocator.free(self.cwd);
        if (self.transcript) |t| self.allocator.free(t);
        for ([_]*std.ArrayList([]u8){ &self.commands, &self.prefixes, &self.hooked }) |l| {
            for (l.items) |x| self.allocator.free(x);
            l.deinit(self.allocator);
        }
        if (self.pending) |p| self.allocator.free(p.token);
        if (self.fzf_args_owned) self.allocator.free(self.fzf_args);
        for (self.arg_store.items) |x| self.allocator.free(x);
        self.arg_store.deinit(self.allocator);
    }

    /// pi.arg.k = v. Glyph rules take the first character; an empty value
    /// leaves the rule as it was.
    fn setArg(self: *Keys, k: []const u8, v: []const u8) void {
        const eql = std.mem.eql;
        if (eql(u8, k, "fzf")) return self.setFzfArgs(v);
        if (eql(u8, k, "whlSpeed")) {
            self.wheel_speed = std.fmt.parseInt(u32, std.mem.trim(u8, v, " "), 10) catch return;
            self.wheel_acc = 0;
            return;
        }
        if (v.len == 0) return;
        const glyph: ?*u21 = if (eql(u8, k, "border")) &self.rules.border else if (eql(u8, k, "prompt")) &self.rules.prompt else if (eql(u8, k, "bash")) &self.rules.bash else null;
        if (glyph) |g| {
            const n = std.unicode.utf8ByteSequenceLength(v[0]) catch return;
            if (n > v.len) return;
            g.* = std.unicode.utf8Decode(v[0..n]) catch return;
            return;
        }
        const text: ?*[]const u8 = if (eql(u8, k, "busy")) &self.rules.busy else if (eql(u8, k, "running")) &self.rules.running else null;
        if (text) |t| {
            const copy = self.allocator.dupe(u8, v) catch return;
            self.arg_store.append(self.allocator, copy) catch return self.allocator.free(copy);
            t.* = copy;
        }
    }

    /// Wheel reports in a stdin chunk (no modal overlay up): every
    /// `wheel_speed` notches one way send one PgUp / PgDn; the rest of the
    /// chunk goes to the TUI as is. A pause or a change of direction starts
    /// the count over.
    fn onWheel(self: *Keys, bytes: []const u8) void {
        var rest: std.ArrayList(u8) = .{};
        defer rest.deinit(self.allocator);
        const net = input.splitWheel(self.allocator, bytes, &rest) catch return self.write(bytes);
        const now: i64 = @intCast(std.time.nanoTimestamp());
        if (now - self.wheel_last_ns > wheel_reset_ns or (net < 0) != (self.wheel_acc < 0)) self.wheel_acc = 0;
        self.wheel_last_ns = now;
        self.wheel_acc += net;
        const speed: i32 = @intCast(self.wheel_speed);
        while (self.wheel_acc <= -speed) : (self.wheel_acc += speed) rest.appendSlice(self.allocator, "\x1b[5~") catch {};
        while (self.wheel_acc >= speed) : (self.wheel_acc -= speed) rest.appendSlice(self.allocator, "\x1b[6~") catch {};
        if (rest.items.len > 0) self.write(rest.items);
    }

    fn setFzfArgs(self: *Keys, args: []const u8) void {
        const copy = self.allocator.dupe(u8, args) catch return;
        if (self.fzf_args_owned) self.allocator.free(self.fzf_args);
        self.fzf_args = copy;
        self.fzf_args_owned = true;
    }

    fn setTranscript(self: *Keys, path: []const u8) void {
        const copy = self.allocator.dupe(u8, path) catch return;
        if (self.transcript) |t| self.allocator.free(t);
        self.transcript = copy;
    }

    fn setCwd(self: *Keys, dir: []const u8) void {
        const copy = self.allocator.dupe(u8, dir) catch return;
        self.allocator.free(self.cwd);
        self.cwd = copy;
    }

    fn box(self: *Keys) ?screen.Box {
        self.shared.mutex.lock();
        defer self.shared.mutex.unlock();
        return screen.inputBoxWith(self.allocator, &self.shared.grid.term, &self.rules) catch null;
    }

    fn send(self: *Keys, value: anytype) void {
        if (self.side) |s| s.send(value);
    }

    /// Returns true when `bytes` was handled here instead of going to CC.
    /// An open dialog or menu takes every key; focus reports still reach CC.
    fn handle(self: *Keys, bytes: []const u8) bool {
        const key = input.decode(bytes);
        switch (key) {
            // Reported to the sidecar by the main loop (lastFocus); CC gets them.
            .focus_in, .focus_out => return false,
            else => {},
        }
        self.shared.mutex.lock();
        const modal: enum { none, dialog, menu } = if (self.shared.overlay.dialog != null) .dialog else if (self.shared.overlay.menu != null) .menu else .none;
        self.shared.mutex.unlock();
        switch (modal) {
            .dialog => return self.onDialogKey(key),
            .menu => return self.onMenuKey(key),
            .none => {},
        }
        var name_buf: [16]u8 = undefined;
        if (input.hookName(key, &name_buf)) |name| {
            if (inList(self.hooked.items, name) and self.askKey(name)) return true;
        }
        if (self.onToastKey(key, bytes)) return true;
        if (key == .mouse and key.mouse.press and key.mouse.button == 0) {
            self.shared.mutex.lock();
            const hit = self.shared.overlay.badgeHit(key.mouse.x, key.mouse.y, self.shared.grid.term.cols, self.shared.grid.term.rows);
            self.shared.mutex.unlock();
            if (hit) {
                self.send(.{ .t = "badge_click" });
                return true;
            }
        }
        if (self.onDoubleClick(key)) return true;
        if (self.runner.active()) return false;
        return switch (key) {
            .tab => self.onTab(),
            .ctrl_c => self.onCtrlC(),
            .enter => self.onEnter(),
            .ctrl_enter => self.onCtrlEnter(),
            else => false,
        };
    }

    /// A plain double click (left button, no modifiers) pages the way the
    /// wheel last went: the first click goes to the TUI, the second press
    /// and its release become PgUp / PgDn.
    fn onDoubleClick(self: *Keys, key: input.Key) bool {
        if (key != .mouse or key.mouse.button != 0) return false;
        const m = key.mouse;
        if (!m.press) {
            if (!self.swallow_release) return false;
            self.swallow_release = false;
            return true;
        }
        const now: i64 = @intCast(std.time.nanoTimestamp());
        if (self.click) |c| if (now - c.ns < double_click_ns and @max(c.x, m.x) - @min(c.x, m.x) <= 1 and c.y == m.y) {
            self.click = null;
            self.swallow_release = true;
            self.write(if (self.wheel_dir < 0) "\x1b[5~" else "\x1b[6~");
            return true;
        };
        self.click = .{ .ns = now, .x = m.x, .y = m.y };
        return false;
    }

    /// A top-right (non-modal) dialog borrows ←/→ while it's up, to pick
    /// the button its timeout will press; after that Enter presses it and
    /// Esc dismisses it, until a key goes to the TUI. Its buttons can also
    /// be clicked. Each of these tells the sidecar, which stops the
    /// countdown (the toast then stays up until Enter or Esc).
    fn onToastKey(self: *Keys, key: input.Key, bytes: []const u8) bool {
        const sh = self.shared;
        sh.mutex.lock();
        defer sh.mutex.unlock();
        const t = &(sh.overlay.toast orelse return false);
        switch (key) {
            .left, .right => {
                if (t.buttons.len < 2) return false;
                t.move(if (key == .left) .prev else .next);
                t.engaged = true;
                sh.paintOverlay();
                self.send(.{ .t = "dialog_active", .id = t.id, .index = t.active });
                return true;
            },
            .enter => if (t.engaged and t.buttons.len > 0) {
                self.send(.{ .t = "dialog_button", .id = t.id, .index = t.active });
                return true;
            },
            .esc => if (t.engaged) {
                const id = t.id;
                sh.overlay.closeToast();
                sh.repaint();
                self.send(.{ .t = "dialog_closed", .id = id });
                return true;
            },
            .mouse => |m| if (m.press and m.button == 0) if (t.buttonAt(m.x, m.y)) |i| {
                t.active = i;
                sh.paintOverlay();
                self.send(.{ .t = "dialog_button", .id = t.id, .index = i });
                return true;
            },
            else => {},
        }
        if (!input.isNoise(bytes)) t.engaged = false;
        return false;
    }

    /// A plugin hooked this key: ask the sidecar (briefly blocking) whether
    /// a listener returned false, i.e. the default action is cancelled.
    fn askKey(self: *Keys, name: []const u8) bool {
        const side = self.side orelse return false;
        const id = self.next_req;
        self.next_req += 1;
        self.key_reply = null;
        self.send(.{ .t = "key", .id = id, .name = name });
        const deadline = std.time.milliTimestamp() + key_hook_wait_ms;
        while (std.time.milliTimestamp() < deadline) {
            var fds = [_]posix.pollfd{.{ .fd = side.stdoutFd(), .events = posix.POLL.IN, .revents = 0 }};
            const left_ms: i32 = @intCast(@max(1, deadline - std.time.milliTimestamp()));
            _ = posix.poll(&fds, left_ms) catch return false;
            if (fds[0].revents == 0) continue;
            if (!side.pump(self, onSidecarLine)) return false;
            if (self.key_reply) |r| if (r.id == id) return r.prevent;
        }
        return false;
    }

    /// ←/→/Tab move between buttons, Enter presses one (the sidecar decides
    /// whether that closes the dialog), Esc / Ctrl+C dismiss it.
    fn onDialogKey(self: *Keys, key: input.Key) bool {
        const sh = self.shared;
        sh.mutex.lock();
        defer sh.mutex.unlock();
        const d = &(sh.overlay.dialog orelse return true);
        const n = d.buttons.len;
        const mv: ?overlay_mod.Dialog.Move = switch (key) {
            .left, .shift_tab => .prev,
            .right, .tab => .next,
            .up => .up,
            .down => .down,
            else => null,
        };
        if (mv) |dir| {
            d.move(dir);
            sh.paintOverlay();
            self.send(.{ .t = "dialog_active", .id = d.id, .index = d.active });
            return true;
        }
        if (key == .mouse and key.mouse.press and key.mouse.button == 0) {
            if (d.buttonAt(key.mouse.x, key.mouse.y)) |i| {
                d.active = i;
                sh.paintOverlay();
                self.send(.{ .t = "dialog_button", .id = d.id, .index = i });
            }
            return true;
        }
        switch (key) {
            .enter => if (n > 0) {
                self.send(.{ .t = "dialog_button", .id = d.id, .index = d.active });
            } else self.dismissDialog(),
            .esc, .ctrl_c => self.dismissDialog(),
            else => {},
        }
        return true;
    }

    /// Mutex held.
    fn dismissDialog(self: *Keys) void {
        const id = self.shared.overlay.dialog.?.id;
        self.shared.overlay.closeDialog();
        self.shared.repaint();
        self.send(.{ .t = "dialog_closed", .id = id });
    }

    fn onMenuKey(self: *Keys, key: input.Key) bool {
        const sh = self.shared;
        sh.mutex.lock();
        defer sh.mutex.unlock();
        const m = &(sh.overlay.menu orelse return true);
        const n = m.items.len;
        const pick: ?usize = switch (key) {
            .up, .shift_tab => {
                m.active = (m.active + n - 1) % n;
                sh.paintOverlay();
                return true;
            },
            .down, .tab => {
                m.active = (m.active + 1) % n;
                sh.paintOverlay();
                return true;
            },
            .enter => m.active,
            .esc, .ctrl_c => null,
            else => return true,
        };
        const id = m.id;
        sh.overlay.closeMenu();
        sh.repaint();
        self.send(.{ .t = "menu_result", .id = id, .index = pick });
        return true;
    }

    /// Ctrl+Enter: paste the clipboard (bracketed when CC asked for it)
    /// and submit. Takes over CC's own Ctrl+Enter (chat:sendNow).
    fn onCtrlEnter(self: *Keys) bool {
        const text = readClipboard(self.allocator) orelse return true;
        defer self.allocator.free(text);
        // An ESC in the clipboard could end the paste early and inject keys.
        const clean = std.mem.replaceOwned(u8, self.allocator, text, "\x1b", "") catch return true;
        defer self.allocator.free(clean);
        self.shared.mutex.lock();
        const bracketed = self.shared.grid.term.modes.get(.bracketed_paste);
        self.shared.mutex.unlock();
        const payload = if (bracketed)
            std.fmt.allocPrint(self.allocator, "\x1b[200~{s}\x1b[201~", .{clean}) catch return true
        else
            self.allocator.dupe(u8, clean) catch return true;
        defer self.allocator.free(payload);
        self.runner.write(payload) catch return true;
        self.runner.push(.{ .settle = enter_gap_ms }) catch {};
        self.runner.write("\r") catch {};
        self.runner.push(.{ .settle = 250 }) catch {};
        self.runner.push(.enter_if_text) catch {};
        return true;
    }

    /// `./x` / `/~/x` + Tab: fzf on the real tty, then swap the token for
    /// an @-mention. A plugin's `pi.complete` prefix: ask it for candidates
    /// (answered in finishCompletion).
    fn onTab(self: *Keys) bool {
        var b = self.box() orelse return false;
        defer b.deinit(self.allocator);
        if (b.empty) return false;
        const tok = b.tokenBeforeCursor() orelse return false;
        const comp = input.completion(tok) orelse return self.askCompletion(tok, b.mode);
        const dir = if (comp.root == .cwd) self.cwd else self.home;

        self.pauseOutput();
        const picked = fzf.pickPath(self.allocator, dir, comp.query, self.fzf_args) catch null;
        defer if (picked) |p| self.allocator.free(p);
        self.resumeOutput();

        const path = picked orelse return true;
        const m = input.mention(self.allocator, b.mode, path, self.project_root) catch return true;
        defer self.allocator.free(m);
        self.replaceToken(tok, m);
        return true;
    }

    fn askCompletion(self: *Keys, tok: []const u8, mode: screen.Mode) bool {
        var best: ?[]const u8 = null;
        for (self.prefixes.items) |p| {
            if (std.mem.startsWith(u8, tok, p) and (best == null or p.len > best.?.len)) best = p;
        }
        const prefix = best orelse return false;
        const token = self.allocator.dupe(u8, tok) catch return false;
        if (self.pending) |p| self.allocator.free(p.token);
        const id = self.next_req;
        self.next_req += 1;
        self.pending = .{ .id = id, .token = token, .prefix_len = prefix.len, .mode = mode };
        self.send(.{ .t = "complete", .id = id, .prefix = prefix, .token = tok });
        return true;
    }

    /// The plugin's candidates for a pending Tab: pick one in fzf and type
    /// it in place of the token (as-is: the plugin decides `@…`, URLs, …).
    /// `pick`: the plugin turns the chosen line into the text first (a tab
    /// title into a screenshot's `@path`); the token waits for finishPick.
    fn finishCompletion(self: *Keys, id: u32, items: []const []const u8, pick: bool) void {
        const p = self.pending orelse return;
        if (p.id != id) return;
        self.pending = null;
        var keep = false;
        defer if (!keep) self.allocator.free(p.token);
        if (items.len == 0) return;
        self.pauseOutput();
        const picked = fzf.pickLine(self.allocator, items, p.token[p.prefix_len..], self.fzf_args) catch null;
        defer if (picked) |x| self.allocator.free(x);
        self.resumeOutput();
        const choice = picked orelse return;
        if (pick) {
            keep = true;
            self.pending = p;
            self.send(.{ .t = "picked", .id = id, .item = choice });
            return;
        }
        self.typeCompletion(p.token, choice);
    }

    /// The plugin's text for a picked line; null / "" types nothing.
    fn finishPick(self: *Keys, id: u32, text: ?[]const u8) void {
        const p = self.pending orelse return;
        if (p.id != id) return;
        self.pending = null;
        defer self.allocator.free(p.token);
        const t = text orelse return;
        if (t.len > 0) self.typeCompletion(p.token, t);
    }

    fn typeCompletion(self: *Keys, token: []const u8, choice: []const u8) void {
        const text = std.fmt.allocPrint(self.allocator, "{s} ", .{choice}) catch return;
        defer self.allocator.free(text);
        self.replaceToken(token, text);
    }

    /// Backspace over `tok` (just left of the caret) and type `with`.
    fn replaceToken(self: *Keys, tok: []const u8, with: []const u8) void {
        var out: std.ArrayList(u8) = .{};
        defer out.deinit(self.allocator);
        const n = std.unicode.utf8CountCodepoints(tok) catch tok.len;
        for (0..n) |_| out.appendSlice(self.allocator, input.backspace) catch return;
        out.appendSlice(self.allocator, with) catch return;
        self.write(out.items);
    }

    /// Hand the terminal to fzf: CC's output keeps landing in the grid only.
    fn pauseOutput(self: *Keys) void {
        self.shared.mutex.lock();
        self.shared.paused = true;
        self.shared.mutex.unlock();
        term.writeAll(stdout_fd, fzf.prelude);
    }

    /// Take it back: repaint grid + overlays, forward output again.
    fn resumeOutput(self: *Keys) void {
        self.shared.mutex.lock();
        defer self.shared.mutex.unlock();
        self.shared.repaint();
        self.shared.paused = false;
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

    /// Enter on a single-line `/~/name`: create ~/claude/name, put a
    /// command that opens cld-pi there on the clipboard, and say so in a
    /// dialog. This session stays where it is.
    fn onEnter(self: *Keys) bool {
        const a = self.allocator;
        var b = self.box() orelse return false;
        defer b.deinit(a);
        if (self.runCommand(&b)) return true;
        const target = (input.cdTarget(a, &b, self.home) catch null) orelse return false;
        defer a.free(target);
        std.fs.cwd().makePath(target) catch return false;
        if (input.ctrlCPlan(a, &b) catch null) |clear| {
            defer a.free(clear);
            self.write(clear);
        }
        const cmd = input.launchCommand(a, target) catch return true;
        defer a.free(cmd);
        const copied = copyToClipboard(a, cmd);
        // The sidecar knows whether this is a dropdown terminal (Yakuake /
        // Guake) and can open a tab there; it also paints the dialog. No
        // sidecar: a plain wrapper dialog with the paste instruction.
        if (self.side) |s| {
            if (s.alive) {
                self.send(.{ .t = "launch", .title = target, .cmd = cmd, .copied = copied });
                return true;
            }
        }
        self.showMessage(
            target,
            if (copied) "Launch command copied, paste it in a new terminal:" else "Run this in a new terminal (clipboard unavailable):",
            cmd,
        );
        return true;
    }

    /// Enter on a single line `/name args` where a plugin registered `name`:
    /// clear the box and run it in the sidecar; CC never sees it.
    fn runCommand(self: *Keys, b: *const screen.Box) bool {
        if (b.empty or b.mode != .prompt or b.lines.len != 1) return false;
        const text = std.mem.trim(u8, b.lines[0], " ");
        if (text.len < 2 or text[0] != '/') return false;
        const end = std.mem.indexOfScalar(u8, text, ' ') orelse text.len;
        const name = text[1..end];
        if (!inList(self.commands.items, name)) return false;
        if (input.ctrlCPlan(self.allocator, b) catch null) |clear| {
            defer self.allocator.free(clear);
            self.write(clear);
        }
        self.send(.{ .t = "command", .name = name, .args = std.mem.trim(u8, text[end..], " ") });
        return true;
    }

    /// A wrapper-owned dialog (id 0, no buttons: Enter / Esc close it).
    fn showMessage(self: *Keys, title: []const u8, line1: []const u8, line2: []const u8) void {
        const a = self.allocator;
        const t = a.dupe(u8, title) catch return;
        const body = std.fmt.allocPrint(a, "{s}\n{s}", .{ line1, line2 }) catch {
            a.free(t);
            return;
        };
        const footer = a.dupe(u8, "enter / esc to close") catch {
            a.free(t);
            a.free(body);
            return;
        };
        self.shared.mutex.lock();
        defer self.shared.mutex.unlock();
        self.shared.overlay.openDialog(.{ .id = 0, .title = t, .body = body, .footer = footer, .buttons = &.{} });
        self.shared.repaint();
    }

    /// Type `text` + Enter as one write, after a quiet gap. Text and Enter
    /// split up lets CC's path/command suggestions pop up in between and
    /// swallow the Enter; a burst glued to the previous write is taken as a
    /// paste (Enter becomes a newline). Both seen against real CC. If a
    /// popup still took the Enter, the text is left in the box: Enter again.
    /// A leading `!` is typed on its own first: inside a burst CC takes it
    /// as text instead of switching to bash mode.
    fn submit(self: *Keys, text: []const u8) !void {
        var rest = text;
        if (rest.len > 1 and rest[0] == '!') {
            try self.runner.push(.{ .settle = enter_gap_ms });
            try self.runner.write("!");
            rest = rest[1..];
        }
        try self.runner.push(.{ .settle = enter_gap_ms });
        const line = try std.fmt.allocPrint(self.allocator, "{s}\r", .{rest});
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
        return screen.isBusy(self.allocator, &self.shared.grid.term, &self.rules);
    }

    pub fn commandRunning(self: *Keys) bool {
        self.shared.mutex.lock();
        defer self.shared.mutex.unlock();
        return screen.commandRunning(self.allocator, &self.shared.grid.term, &self.rules);
    }

    pub fn done(self: *Keys, id: u32) void {
        self.send(.{ .t = "done", .id = id });
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

fn copyToClipboard(allocator: std.mem.Allocator, text: []const u8) bool {
    const argv = [_][]const u8{ "/bin/sh", "-c", "wl-copy 2>/dev/null || xclip -selection clipboard -i 2>/dev/null || pbcopy 2>/dev/null" };
    var child = std.process.Child.init(&argv, allocator);
    child.stdin_behavior = .Pipe;
    child.stdout_behavior = .Ignore;
    child.stderr_behavior = .Ignore;
    child.spawn() catch return false;
    child.stdin.?.writeAll(text) catch {};
    child.stdin.?.close();
    child.stdin = null;
    const res = child.wait() catch return false;
    return res == .Exited and res.Exited == 0;
}

fn readClipboard(allocator: std.mem.Allocator) ?[]u8 {
    const res = std.process.Child.run(.{
        .allocator = allocator,
        .argv = &.{ "/bin/sh", "-c", "wl-paste --no-newline 2>/dev/null || xclip -o -selection clipboard 2>/dev/null || pbpaste 2>/dev/null" },
        .max_output_bytes = 16 * 1024 * 1024,
    }) catch return null;
    allocator.free(res.stderr);
    if (res.stdout.len == 0) {
        allocator.free(res.stdout);
        return null;
    }
    return res.stdout;
}

/// Messages from the sidecar:
///   {"t":"submit","data":s}  pi`s`: replace the box text with s + Enter
///   {"t":"buffer","data":s}  pi.BUFFER = s: replace the input box text
///   {"t":"write","data":s}   raw bytes to the pty
///   {"t":"arg","key":k,"value":v}  pi.arg.k = v (fzf, whlSpeed, border,
///        prompt, bash, busy, running)
///   {"t":"dialog","id","title","body","footer","buttons":[..],"modal","eachRow","fadeX"}
///        pi.dialog; modal:false (timeout set) is drawn top-right and leaves
///        the keyboard to CC; fadeX: columns per button background fade
///   {"t":"launch","title","cmd","copied"}  /~/name + Enter: open a tab in
///        a dropdown terminal (or say how to paste), then repaint
///   {"t":"dialog_update","id","index"?,"label"?,"title"?,"body"?,"footer"?}
///        relabel a button (callback returned a string) and/or replace texts
///   {"t":"dialog_close","id"}
///   {"t":"badge","text":s|null,"pos"?:"rd","sgr"?}  top-right (or bottom-
///        right) label, sgr: its SGR params; clicks come back as badge_click
///   {"t":"title","text":s|null}  window title (OSC 2); null restores the old one
///   {"t":"press","key":k,"id"?}  pi.press: enter/esc/tab/up/down/left/right/…
///   {"t":"commands","names":[..]} {"t":"completions","prefixes":[..]}
///   {"t":"keys","names":[..]}     what plugins registered (replaces the lists)
///   {"t":"key_result","id","prevent"}  answer to a {"t":"key"} question
///   {"t":"complete_result","id","items":[..],"pick"?:true}  answer to
///        {"t":"complete"}; pick: send {"t":"picked","id","item"} instead of
///        typing the choice, and type {"t":"pick_result","id","text"} (null: nothing)
/// `id` on submit/press: reply {"t":"done","id"} once it has been typed.
///   {"t":"menu","id","items":[..]}  pi.menu
///   {"t":"paint","rows":[[row, text], ..]}  pi.sed results ("" blanks)
///   {"t":"subscribe","scr":bool}
/// Sidecar lines that arrive before the pty / Keys exist (plugin loading
/// happens before claude starts; its pi.command names must reach the
/// plugin dir in time). `ready` says host.js finished loading plugins.
const Prelude = struct {
    allocator: std.mem.Allocator,
    lines: std.ArrayList([]u8) = .{},
    ready: bool = false,

    fn onLine(self: *Prelude, line: []const u8) void {
        if (std.mem.eql(u8, std.mem.trim(u8, line, " \t\r"), "{\"t\":\"ready\"}")) {
            self.ready = true;
            return;
        }
        const copy = self.allocator.dupe(u8, line) catch return;
        self.lines.append(self.allocator, copy) catch self.allocator.free(copy);
    }

    fn clear(self: *Prelude) void {
        for (self.lines.items) |l| self.allocator.free(l);
        self.lines.clearRetainingCapacity();
    }

    fn deinit(self: *Prelude) void {
        self.clear();
        self.lines.deinit(self.allocator);
    }
};

/// Wait for host.js's `ready` (or the deadline / a dead sidecar), keeping
/// every other line for replay.
fn waitReady(s: *sidecar_mod.Sidecar, pre: *Prelude, timeout_ms: i32) bool {
    const deadline = std.time.milliTimestamp() + timeout_ms;
    while (!pre.ready and s.alive) {
        const left = deadline - std.time.milliTimestamp();
        if (left <= 0) break;
        var fds = [_]posix.pollfd{.{ .fd = s.stdoutFd(), .events = posix.POLL.IN, .revents = 0 }};
        _ = posix.poll(&fds, @intCast(left)) catch break;
        if (fds[0].revents == 0) continue;
        if (!s.pump(pre, Prelude.onLine)) break;
    }
    return pre.ready;
}

fn onSidecarLine(keys: *Keys, line: []const u8) void {
    const a = keys.allocator;
    const parsed = std.json.parseFromSlice(std.json.Value, a, line, .{}) catch return;
    defer parsed.deinit();
    if (parsed.value != .object) return;
    const m = parsed.value.object;
    const t = str(m, "t") orelse return;
    const eql = std.mem.eql;
    const sh = keys.shared;
    if (eql(u8, t, "write")) {
        if (str(m, "data")) |d| keys.write(d);
    } else if (eql(u8, t, "submit")) {
        // Replace whatever draft is in the box, then Enter: appending a
        // command to a draft would send the mix as a prompt.
        if (str(m, "data")) |d| {
            keys.runner.push(.clear_box) catch {};
            keys.submit(d) catch {};
        }
        if (int(m, "id")) |id| keys.runner.push(.{ .done = @intCast(id) }) catch {};
    } else if (eql(u8, t, "press")) {
        const bytes = keyBytes(str(m, "key") orelse return) orelse return;
        keys.runner.write(bytes) catch {};
        if (int(m, "id")) |id| keys.runner.push(.{ .done = @intCast(id) }) catch {};
    } else if (eql(u8, t, "commands")) {
        setList(a, &keys.commands, m.get("names") orelse return);
    } else if (eql(u8, t, "completions")) {
        setList(a, &keys.prefixes, m.get("prefixes") orelse return);
    } else if (eql(u8, t, "keys")) {
        setList(a, &keys.hooked, m.get("names") orelse return);
    } else if (eql(u8, t, "key_result")) {
        const prevent = if (m.get("prevent")) |v| v == .bool and v.bool else false;
        keys.key_reply = .{ .id = @intCast(int(m, "id") orelse return), .prevent = prevent };
    } else if (eql(u8, t, "complete_result")) {
        const items = strList(a, m.get("items") orelse return) catch return;
        defer {
            for (items) |x| a.free(x);
            a.free(items);
        }
        const pick = if (m.get("pick")) |v| v == .bool and v.bool else false;
        keys.finishCompletion(@intCast(int(m, "id") orelse return), items, pick);
    } else if (eql(u8, t, "pick_result")) {
        keys.finishPick(@intCast(int(m, "id") orelse return), str(m, "text"));
    } else if (eql(u8, t, "buffer")) {
        if (str(m, "data")) |d| {
            keys.runner.push(.clear_box) catch {};
            keys.runner.write(d) catch {};
        }
    } else if (eql(u8, t, "arg")) {
        const k = str(m, "key") orelse return;
        keys.setArg(k, str(m, "value") orelse "");
    } else if (eql(u8, t, "dialog")) {
        const d = buildDialog(a, m) catch return;
        const modal = if (m.get("modal")) |v| !(v == .bool and !v.bool) else true;
        sh.mutex.lock();
        defer sh.mutex.unlock();
        var dd = d;
        if (int(m, "active")) |i| if (i < dd.buttons.len) {
            dd.active = i;
        };
        if (modal) sh.overlay.openDialog(dd) else sh.overlay.openToast(dd);
        sh.repaint();
    } else if (eql(u8, t, "badge")) {
        const text = if (str(m, "text")) |v| a.dupe(u8, v) catch return else null;
        const rd = if (str(m, "pos")) |p| eql(u8, p, "rd") else false;
        // Only digits and ';' reach the terminal.
        const sgr = if (str(m, "sgr")) |v| (if (v.len > 0 and std.mem.indexOfNone(u8, v, "0123456789;") == null) a.dupe(u8, v) catch null else null) else null;
        sh.mutex.lock();
        defer sh.mutex.unlock();
        const old = if (rd) sh.overlay.badge_rd else sh.overlay.badge;
        // A label that got no narrower just paints over the old one (the
        // bottom-right one may tick every second); else the cells come back.
        const grow = if (old) |o| (if (text) |n| overlay_mod.width(n) >= overlay_mod.width(o) else false) else true;
        if (rd) sh.overlay.setBadgeRd(text, sgr) else sh.overlay.setBadge(text, sgr);
        if (grow) sh.paintOverlay() else sh.repaint();
    } else if (eql(u8, t, "dialog_update")) {
        sh.mutex.lock();
        defer sh.mutex.unlock();
        const d = sh.overlay.findDialog(int(m, "id") orelse return) orelse return;
        if (int(m, "index")) |i| if (i < d.buttons.len) if (str(m, "label")) |l| {
            const label = a.dupe(u8, l) catch return;
            a.free(d.buttons[i]);
            d.buttons[i] = label;
        };
        inline for (.{ "title", "body", "footer" }) |field| if (str(m, field)) |v| {
            const copy = a.dupe(u8, v) catch return;
            a.free(@field(d, field));
            @field(d, field) = copy;
        };
        sh.repaint();
    } else if (eql(u8, t, "dialog_close")) {
        sh.mutex.lock();
        defer sh.mutex.unlock();
        sh.overlay.closeById(int(m, "id") orelse return);
        sh.repaint();
    } else if (eql(u8, t, "menu")) {
        const items = strList(a, m.get("items") orelse return) catch return;
        if (items.len == 0) {
            a.free(items);
            keys.send(.{ .t = "menu_result", .id = int(m, "id") orelse 0, .index = @as(?usize, null) });
            return;
        }
        // Anchor: right above the input box, at the caret's column.
        var bottom: u16 = 0;
        var col: u16 = 0;
        if (keys.box()) |b0| {
            var b = b0;
            bottom = b.top;
            b.deinit(a);
        }
        sh.mutex.lock();
        defer sh.mutex.unlock();
        if (bottom == 0) bottom = sh.grid.term.rows -| 1;
        col = sh.grid.term.screens.active.cursor.x;
        sh.overlay.openMenu(.{ .id = @intCast(int(m, "id") orelse 0), .items = items, .bottom = bottom, .col = col });
        sh.paintOverlay();
    } else if (eql(u8, t, "paint")) {
        const rows = (m.get("rows") orelse return);
        if (rows != .array) return;
        var idx: std.ArrayList(u16) = .{};
        defer idx.deinit(a);
        var texts: std.ArrayList([]u8) = .{};
        defer texts.deinit(a);
        for (rows.array.items) |r| {
            if (r != .array or r.array.items.len != 2 or r.array.items[0] != .integer or r.array.items[1] != .string) continue;
            const text = a.dupe(u8, r.array.items[1].string) catch continue;
            idx.append(a, @intCast(r.array.items[0].integer)) catch continue;
            texts.append(a, text) catch continue;
        }
        sh.mutex.lock();
        defer sh.mutex.unlock();
        sh.overlay.setPaints(idx.items, texts.items) catch return;
        sh.repaint();
    } else if (eql(u8, t, "title")) {
        var out: std.ArrayList(u8) = .{};
        defer out.deinit(a);
        if (str(m, "text")) |text| {
            if (!keys.title_pushed) out.appendSlice(a, "\x1b[22;2t") catch return;
            keys.title_pushed = true;
            out.appendSlice(a, "\x1b]2;") catch return;
            // No control bytes: they'd end the OSC early.
            for (text) |c| if (c >= 0x20 and c != 0x7f) out.append(a, c) catch return;
            out.append(a, 0x07) catch return;
        } else if (keys.title_pushed) {
            keys.title_pushed = false;
            out.appendSlice(a, "\x1b[23;2t") catch return;
        }
        sh.mutex.lock();
        defer sh.mutex.unlock();
        term.writeAll(stdout_fd, out.items);
    } else if (eql(u8, t, "subscribe")) {
        if (m.get("scr")) |v| keys.scr_subscribed = v == .bool and v.bool;
        // Dump right away instead of waiting for CC to draw something.
        sh.dirty.store(true, .seq_cst);
    }
}

/// Bytes for pi.press(name).
fn keyBytes(name: []const u8) ?[]const u8 {
    const table = [_]struct { []const u8, []const u8 }{
        .{ "enter", "\r" },    .{ "esc", "\x1b" },     .{ "tab", "\t" },        .{ "backspace", "\x7f" },
        .{ "up", "\x1b[A" },   .{ "down", "\x1b[B" },  .{ "right", "\x1b[C" },  .{ "left", "\x1b[D" },
        .{ "ctrl-c", "\x03" }, .{ "shift-tab", "\x1b[Z" }, .{ "ctrl-o", "\x0f" },    .{ "ctrl-r", "\x12" },
    };
    for (table) |e| if (std.mem.eql(u8, name, e[0])) return e[1];
    return null;
}

fn inList(list: []const []u8, s: []const u8) bool {
    for (list) |x| if (std.mem.eql(u8, x, s)) return true;
    return false;
}

/// Replace `list` with the strings in JSON array `v`.
fn setList(a: std.mem.Allocator, list: *std.ArrayList([]u8), v: std.json.Value) void {
    const items = strList(a, v) catch return;
    defer a.free(items);
    for (list.items) |x| a.free(x);
    list.clearRetainingCapacity();
    list.appendSlice(a, items) catch {
        for (items) |x| a.free(x);
    };
}

fn str(m: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const v = m.get(key) orelse return null;
    return if (v == .string) v.string else null;
}

fn int(m: std.json.ObjectMap, key: []const u8) ?usize {
    const v = m.get(key) orelse return null;
    return if (v == .integer and v.integer >= 0) @intCast(v.integer) else null;
}

fn strList(a: std.mem.Allocator, v: std.json.Value) ![][]u8 {
    if (v != .array) return error.NotArray;
    var out: std.ArrayList([]u8) = .{};
    errdefer {
        for (out.items) |x| a.free(x);
        out.deinit(a);
    }
    for (v.array.items) |x| if (x == .string) try out.append(a, try a.dupe(u8, x.string));
    return out.toOwnedSlice(a);
}

fn buildDialog(a: std.mem.Allocator, m: std.json.ObjectMap) !overlay_mod.Dialog {
    const title = try a.dupe(u8, str(m, "title") orelse "");
    errdefer a.free(title);
    const body = try a.dupe(u8, str(m, "body") orelse "");
    errdefer a.free(body);
    const footer = try a.dupe(u8, str(m, "footer") orelse "");
    errdefer a.free(footer);
    const buttons = try strList(a, m.get("buttons") orelse .{ .array = .init(a) });
    errdefer {
        for (buttons) |x| a.free(x);
        a.free(buttons);
    }
    // eachRow: [2, 2] (counts per row) or "vertical" (one per row).
    var layout: std.ArrayList(u8) = .{};
    errdefer layout.deinit(a);
    if (m.get("eachRow")) |v| switch (v) {
        .string => |sv| if (std.mem.eql(u8, sv, "vertical")) try layout.append(a, 1),
        .array => |arr| for (arr.items) |x| {
            if (x == .integer and x.integer > 0) try layout.append(a, @intCast(@min(x.integer, 255)));
        },
        else => {},
    };
    return .{
        .id = @intCast(int(m, "id") orelse 0),
        .title = title,
        .body = body,
        .footer = footer,
        .buttons = buttons,
        .layout = try layout.toOwnedSlice(a),
        .fade_x = @intCast(@min(int(m, "fadeX") orelse 2, 64)),
    };
}

/// Whether `argv` asks for interactive mode: no arguments, or only the
/// resume/continue flags (`-r [id]`, `--resume [id]`, `-c`, `--continue`),
/// which are handed to claude as-is. Anything else (a prompt, other flags)
/// is `claude -p` mode. Callers also require stdin to be a terminal, so
/// `echo hi | claude-p` keeps reading the prompt from stdin.
/// `-a <cmd> [args…]` wraps another TUI instead of claude.
pub fn wantsInteractive(argv: []const []const u8) bool {
    if (otherApp(argv) != null) return true;
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

/// `-a <cmd> [args…]`: the command line of another TUI to wrap.
fn otherApp(argv: []const []const u8) ?[]const []const u8 {
    if (argv.len < 2 or !std.mem.eql(u8, argv[0], "-a")) return null;
    return argv[1..];
}

/// `extra` is appended to the claude command line (see wantsInteractive),
/// or is `-a <cmd> [args…]`: run that TUI as is (no hooks, no settings;
/// pi.arg.border / prompt / … describe its screen).
pub fn run(allocator: std.mem.Allocator, extra: []const []const u8) !u8 {
    if (!posix.isatty(stdin_fd) or !posix.isatty(stdout_fd)) {
        term.writeAll(2, "claude-p: interactive mode needs a terminal (pass a prompt for `claude -p` mode)\n");
        return 2;
    }

    const data_dir = try dataDir(allocator);
    defer allocator.free(data_dir);
    const scr_path = try std.fs.path.join(allocator, &.{ data_dir, "scr" });
    defer allocator.free(scr_path);
    const log_path = try std.fs.path.join(allocator, &.{ data_dir, "host.log" });
    defer allocator.free(log_path);
    // `scr` and `host.log` are only written while they exist; touching one
    // turns it on for this session. Declared before the sidecar's defer, so
    // this runs after the sidecar is gone.
    defer for ([_][]const u8{ scr_path, log_path }) |p| std.fs.cwd().deleteFile(p) catch {};
    const installed_path = try std.fs.path.join(allocator, &.{ data_dir, ".installed" });
    defer allocator.free(installed_path);
    const first_run = blk: {
        std.fs.cwd().access(installed_path, .{}) catch break :blk true;
        break :blk false;
    };

    var harness = try hook.createWith(allocator, .{ .events = &hook_events, .fullscreen = true, .plugin = true });
    defer harness.deinit();

    // Open the FIFO read end (plus a dummy writer so it never reports HUP
    // between hook invocations) BEFORE spawning claude.
    const fifo_z = try allocator.dupeZ(u8, harness.fifo_path);
    defer allocator.free(fifo_z);
    const fifo_fd = try posix.openZ(fifo_z, .{ .ACCMODE = .RDONLY, .NONBLOCK = true, .CLOEXEC = true }, 0);
    defer posix.close(fifo_fd);
    const fifo_keep = try posix.openZ(fifo_z, .{ .ACCMODE = .WRONLY, .NONBLOCK = true, .CLOEXEC = true }, 0);
    defer posix.close(fifo_keep);

    // Start the sidecar first: its plugins register pi.command names, and
    // the stubs must be in the plugin dir before claude scans --plugin-dir.
    // Messages it emits in the meantime wait in `prelude` and are replayed
    // once Keys is up.
    var prelude: Prelude = .{ .allocator = allocator };
    defer prelude.deinit();
    var side: ?sidecar_mod.Sidecar = null;
    if (sidecar_mod.findHost(allocator)) |host_path| {
        defer allocator.free(host_path);
        side = sidecar_mod.spawn(allocator, host_path, harness.plugin_dir) catch null;
    }
    defer if (side) |*s| s.deinit();
    if (side) |*s| _ = waitReady(s, &prelude, 3000);

    const claude_bin = posix.getenv("CLAUDE_P_CLAUDE") orelse "claude";
    var argv: std.ArrayList([]const u8) = .{};
    defer argv.deinit(allocator);
    if (otherApp(extra)) |app| try argv.appendSlice(allocator, app) else {
        try argv.appendSlice(allocator, &.{ claude_bin, "--settings", harness.settings_json });
        if (side != null) if (harness.plugin_dir) |pd| try argv.appendSlice(allocator, &.{ "--plugin-dir", pd });
        try argv.appendSlice(allocator, extra);
    }
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
    var shared: Shared = .{ .allocator = allocator, .grid = grid, .overlay = .{ .allocator = allocator } };
    defer shared.overlay.deinit();

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

    // After both children are forked: a dead sidecar must not kill us.
    term.ignoreSigpipe();
    if (side) |*s| s.send(.{
        .t = "init",
        .dataDir = data_dir,
        .scr = scr_path,
        .cols = sz.cols,
        .rows = sz.rows,
        .pid = std.c.getpid(),
        .arg = .{
            .fzf = fzf.default_args,
            .whlSpeed = std.fmt.comptimePrint("{d}", .{default_wheel_speed}),
            .border = "\u{2500}",
            .prompt = "\u{276F}",
            .bash = "!",
            .busy = (screen.Rules{}).busy,
            .running = (screen.Rules{}).running,
        },
        .app = if (otherApp(extra)) |app| app[0] else "claude",
    });

    var keys = try Keys.init(allocator, &shared, session);
    defer keys.deinit();
    if (side) |*s| {
        keys.side = s;
        for (prelude.lines.items) |line| onSidecarLine(&keys, line);
        prelude.clear();
    }

    var fifo_buf: std.ArrayList(u8) = .{};
    defer fifo_buf.deinit(allocator);
    var last_scr_ns: i64 = 0;
    // When the last key we forwarded to CC was Ctrl+C (else null). If CC
    // exits right after, the user quit with Ctrl+C: drop the conversation.
    var ctrl_c_ns: ?i64 = null;
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
            if (input.lastFocus(inbuf[0..n])) |f| keys.send(.{ .t = "focus", .focused = f });
            const wheel = input.hasWheel(inbuf[0..n]);
            if (wheel) {
                shared.wheel_ns.store(@intCast(std.time.nanoTimestamp()), .seq_cst);
                var scratch: std.ArrayList(u8) = .{};
                defer scratch.deinit(allocator);
                const net = input.splitWheel(allocator, inbuf[0..n], &scratch) catch 0;
                if (net != 0) {
                    keys.wheel_dir = if (net < 0) -1 else 1;
                    keys.send(.{ .t = "wheel", .dir = keys.wheel_dir });
                }
            }
            shared.mutex.lock();
            const modal = shared.overlay.dialog != null or shared.overlay.menu != null;
            shared.mutex.unlock();
            if (wheel and !modal and keys.wheel_speed > 0) {
                keys.onWheel(inbuf[0..n]);
            } else if (!keys.handle(inbuf[0..n])) {
                session.writeInput(inbuf[0..n]) catch {};
                // Mouse motion, focus reports and the Ctrl key's release
                // can arrive before CC exits; they don't count as a key.
                if (input.decode(inbuf[0..n]) == .ctrl_c) {
                    ctrl_c_ns = @intCast(std.time.nanoTimestamp());
                } else if (!input.isNoise(inbuf[0..n])) ctrl_c_ns = null;
            }
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
                    if (hook.extractTranscriptPath(allocator, ln.payload) catch null) |t| {
                        defer allocator.free(t);
                        keys.setTranscript(t);
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
        if (now - shared.last_output_ns.load(.seq_cst) >= overlay_settle_ns and
            now - shared.wheel_ns.load(.seq_cst) >= wheel_window_ns)
        {
            shared.mutex.lock();
            if (shared.overlay_stale and !shared.paused) {
                shared.overlay_stale = false;
                if (shared.overlay.active()) shared.paintOverlay();
            }
            shared.mutex.unlock();
        }
        if (shared.dirty.load(.seq_cst) and now - last_scr_ns >= scr_interval_ns) {
            last_scr_ns = now;
            writeScr(&shared, scr_path, &keys);
        }
    }
    if (shared.dirty.load(.seq_cst)) writeScr(&shared, scr_path, &keys);

    if (keys.title_pushed) term.writeAll(stdout_fd, "\x1b[23;2t");
    // If CC died without leaving the alt screen, don't strand the user there.
    shared.mutex.lock();
    const stuck_alt = grid.onAltScreen();
    shared.mutex.unlock();
    if (stuck_alt) term.writeAll(stdout_fd, "\x1b[?1049l");
    term.writeAll(stdout_fd, "\x1b[?25h");
    term.restore(stdin_fd, orig_termios);

    const quit_by_ctrl_c = if (ctrl_c_ns) |t|
        @as(i64, @intCast(std.time.nanoTimestamp())) - t < ctrl_c_exit_window_ns
    else
        false;
    // Quit with Ctrl+C: the conversation moves to ~/claude/last (an empty
    // one stays and nothing is printed).
    if (quit_by_ctrl_c) if (keys.transcript) |t| {
        const last = try std.fs.path.join(allocator, &.{ keys.home, "claude", "last" });
        defer allocator.free(last);
        if (convo.stash(allocator, t, last, "~/claude/last")) |restore| {
            defer allocator.free(restore);
            term.writeAll(1, "To restore #> ");
            term.writeAll(1, restore);
            term.writeAll(1, "\n");
        }
    };

    if (first_run) {
        term.writeAll(1, rc_hint);
        if (std.fs.cwd().createFile(installed_path, .{})) |f| f.close() else |_| {}
    }
    return shared.exit_code.load(.seq_cst);
}

/// Dump the grid to `scr` (if the file exists), and to the sidecar when it
/// subscribed. Neither: no snapshot at all.
fn writeScr(shared: *Shared, scr_path: []const u8, keys: *Keys) void {
    const to_file = if (std.fs.cwd().access(scr_path, .{})) true else |_| false;
    shared.dirty.store(false, .seq_cst);
    if (!to_file and !keys.scr_subscribed) return;
    shared.mutex.lock();
    const text = shared.grid.snapshot(shared.allocator) catch {
        shared.mutex.unlock();
        return;
    };
    const cur = shared.grid.term.screens.active.cursor;
    shared.mutex.unlock();
    defer shared.allocator.free(text);
    if (keys.scr_subscribed) sendScr(keys, text, cur.y, cur.x);
    if (!to_file) return;
    // Write-then-rename so readers never see a half-written frame.
    var tmp_buf: [std.fs.max_path_bytes]u8 = undefined;
    const tmp = std.fmt.bufPrint(&tmp_buf, "{s}.tmp", .{scr_path}) catch return;
    const f = std.fs.cwd().createFile(tmp, .{}) catch return;
    f.writeAll(text) catch {};
    f.close();
    std.fs.cwd().rename(tmp, scr_path) catch {};
}

fn sendScr(keys: *Keys, text: []const u8, row: usize, col: usize) void {
    const a = keys.allocator;
    var rows: std.ArrayList([]const u8) = .{};
    defer rows.deinit(a);
    var it = std.mem.splitScalar(u8, std.mem.trimRight(u8, text, "\n"), '\n');
    while (it.next()) |r| rows.append(a, r) catch return;
    keys.send(.{ .t = "scr", .rows = rows.items, .cursor = .{ .row = row, .col = col } });
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
    try t.expect(wantsInteractive(&.{ "-a", "codex", "--full-auto" }));
    try t.expect(!wantsInteractive(&.{"-a"}));
}

test {
    std.testing.refAllDecls(grid_mod);
    std.testing.refAllDecls(@import("screen.zig"));
    std.testing.refAllDecls(@import("input.zig"));
    std.testing.refAllDecls(@import("steps.zig"));
    std.testing.refAllDecls(@import("overlay.zig"));
    std.testing.refAllDecls(convo);
}
