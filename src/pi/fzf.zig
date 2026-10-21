//! Run fzf on the real terminal. The caller pauses CC's output (it keeps
//! landing in the grid) and repaints from the grid afterwards, since fzf
//! scrolls/clears what it drew over and resets modes on exit.
const std = @import("std");

/// Before handing the tty to fzf: drop the extended key reporting CC turned
/// on (pop the whole kitty stack, zero the flags, modifyOtherKeys off) and
/// mouse reporting, or fzf gets CSI-u keys (`100;5u` for ctrl-d, seen in
/// tmux) and mouse noise. Grid.redraw restores all of it.
pub const prelude = "\x1b[<99u\x1b[=0;1u\x1b[>4;0m\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";

/// Default for `pi.arg.fzf`. --cycle wraps ↑/↓ past the ends; ctrl-d picks
/// the folder the highlighted entry is in instead of the entry.
pub const default_args = "--cycle --pointer '\u{25B6}' --bind 'ctrl-d:become(dirname -- {})'";

/// Let the user pick a path under `dir` (fzf's own walker unless the user
/// set FZF_DEFAULT_COMMAND, so stdin must be the tty). `extra` is
/// `pi.arg.fzf`, shell syntax, appended after our flags so it can override
/// them. Returns the absolute path, or null on Esc / no fzf.
pub fn pickPath(allocator: std.mem.Allocator, dir: []const u8, query: []const u8, extra: []const u8) !?[]u8 {
    // A panel under the caret, not a full-screen takeover.
    const cmd = try std.fmt.allocPrint(
        allocator,
        "exec fzf --height=40% --min-height=8 --walker=file,dir,follow,hidden --scheme=path {s} --query=\"$1\"",
        .{extra},
    );
    defer allocator.free(cmd);
    const argv = [_][]const u8{ "/bin/sh", "-c", cmd, "sh", query };
    var child = std.process.Child.init(&argv, allocator);
    child.cwd = dir;
    child.stdin_behavior = .Inherit;
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Inherit;
    child.spawn() catch return null;

    var out: std.ArrayList(u8) = .{};
    defer out.deinit(allocator);
    var buf: [4096]u8 = undefined;
    while (true) {
        const n = child.stdout.?.read(&buf) catch break;
        if (n == 0) break;
        try out.appendSlice(allocator, buf[0..n]);
    }
    const res = child.wait() catch return null;
    if (res != .Exited or res.Exited != 0) return null;
    const line = std.mem.trimRight(u8, out.items, "\r\n");
    if (line.len == 0) return null;
    return try std.fs.path.resolve(allocator, &.{ dir, line });
}

/// Let the user pick one of `items` (a plugin's completion candidates).
/// Returns the chosen line, or null on Esc / no fzf.
pub fn pickLine(allocator: std.mem.Allocator, items: []const []const u8, query: []const u8, extra: []const u8) !?[]u8 {
    const cmd = try std.fmt.allocPrint(
        allocator,
        "exec fzf --height=40% --min-height=8 {s} --query=\"$1\"",
        .{extra},
    );
    defer allocator.free(cmd);
    const argv = [_][]const u8{ "/bin/sh", "-c", cmd, "sh", query };
    var child = std.process.Child.init(&argv, allocator);
    child.stdin_behavior = .Pipe;
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Inherit;
    child.spawn() catch return null;
    // fzf reads the list from stdin and the keyboard from /dev/tty.
    for (items) |it| {
        child.stdin.?.writeAll(it) catch break;
        child.stdin.?.writeAll("\n") catch break;
    }
    child.stdin.?.close();
    child.stdin = null;

    var out: std.ArrayList(u8) = .{};
    defer out.deinit(allocator);
    var buf: [4096]u8 = undefined;
    while (true) {
        const n = child.stdout.?.read(&buf) catch break;
        if (n == 0) break;
        try out.appendSlice(allocator, buf[0..n]);
    }
    const res = child.wait() catch return null;
    if (res != .Exited or res.Exited != 0) return null;
    const line = std.mem.trimRight(u8, out.items, "\r\n");
    if (line.len == 0) return null;
    return try allocator.dupe(u8, line);
}
