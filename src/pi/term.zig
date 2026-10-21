//! Real-terminal plumbing for interactive mode: raw mode, window size, and a
//! SIGWINCH self-pipe the main poll loop can wait on.
const std = @import("std");
const posix = std.posix;

pub const Size = struct { cols: u16, rows: u16 };

pub fn size(fd: posix.fd_t) Size {
    var ws: posix.winsize = .{ .row = 0, .col = 0, .xpixel = 0, .ypixel = 0 };
    const rc = posix.system.ioctl(fd, posix.T.IOCGWINSZ, @intFromPtr(&ws));
    if (posix.errno(rc) != .SUCCESS or ws.col == 0 or ws.row == 0) return .{ .cols = 80, .rows = 24 };
    return .{ .cols = ws.col, .rows = ws.row };
}

/// Put `fd` into raw mode; returns the original termios for `restore`.
pub fn enterRaw(fd: posix.fd_t) !posix.termios {
    const orig = try posix.tcgetattr(fd);
    var raw = orig;
    raw.iflag.IGNBRK = false;
    raw.iflag.BRKINT = false;
    raw.iflag.PARMRK = false;
    raw.iflag.ISTRIP = false;
    raw.iflag.INLCR = false;
    raw.iflag.IGNCR = false;
    raw.iflag.ICRNL = false;
    raw.iflag.IXON = false;
    raw.oflag.OPOST = false;
    raw.lflag.ECHO = false;
    raw.lflag.ECHONL = false;
    raw.lflag.ICANON = false;
    raw.lflag.ISIG = false;
    raw.lflag.IEXTEN = false;
    raw.cflag.CSIZE = .CS8;
    raw.cflag.PARENB = false;
    raw.cc[@intFromEnum(posix.V.MIN)] = 1;
    raw.cc[@intFromEnum(posix.V.TIME)] = 0;
    try posix.tcsetattr(fd, .FLUSH, raw);
    return orig;
}

pub fn restore(fd: posix.fd_t, orig: posix.termios) void {
    posix.tcsetattr(fd, .FLUSH, orig) catch {};
}

/// Write all of `bytes` to `fd`, retrying on short writes / EINTR.
pub fn writeAll(fd: posix.fd_t, bytes: []const u8) void {
    var rest = bytes;
    while (rest.len > 0) {
        const n = posix.write(fd, rest) catch |err| switch (err) {
            error.WouldBlock => continue,
            else => return,
        };
        rest = rest[n..];
    }
}

// -------- SIGWINCH self-pipe --------

var winch_pipe: [2]posix.fd_t = .{ -1, -1 };

fn onWinch(_: i32) callconv(.c) void {
    _ = posix.system.write(winch_pipe[1], "w", 1);
}

/// Install the SIGWINCH handler; returns the read end to poll on.
pub fn watchWinch() !posix.fd_t {
    winch_pipe = try posix.pipe2(.{ .NONBLOCK = true, .CLOEXEC = true });
    posix.sigaction(posix.SIG.WINCH, &.{
        .handler = .{ .handler = onWinch },
        .mask = posix.sigemptyset(),
        .flags = posix.SA.RESTART,
    }, null);
    return winch_pipe[0];
}

/// Drain pending wakeups from the self-pipe.
pub fn drain(fd: posix.fd_t) void {
    var buf: [64]u8 = undefined;
    while (true) {
        const n = posix.read(fd, &buf) catch return;
        if (n == 0) return;
    }
}

pub fn ignoreSigpipe() void {
    posix.sigaction(posix.SIG.PIPE, &.{
        .handler = .{ .handler = posix.SIG.IGN },
        .mask = posix.sigemptyset(),
        .flags = 0,
    }, null);
}
