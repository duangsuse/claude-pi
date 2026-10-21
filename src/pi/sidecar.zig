//! node sidecar (`js/host.js`) over JSON-lines on stdio.
//!
//! Zig → node: {"t":"init",...} {"t":"hook","event":E,"payload":{...}}
//!             {"t":"resize","cols":C,"rows":R}
//! node → Zig: {"t":"write","data":"..."}   bytes for the pty
//!
//! The sidecar is optional: if `host.js` can't be found or node fails to
//! start, interactive mode keeps working as a plain passthrough.
const std = @import("std");
const posix = std.posix;

pub const Sidecar = struct {
    allocator: std.mem.Allocator,
    child: std.process.Child,
    /// Partial line carried over between reads.
    inbuf: std.ArrayList(u8) = .{},
    alive: bool = true,

    pub fn stdoutFd(self: *const Sidecar) posix.fd_t {
        return self.child.stdout.?.handle;
    }

    pub fn deinit(self: *Sidecar) void {
        if (self.child.stdin) |*f| {
            f.close();
            self.child.stdin = null;
        }
        _ = self.child.kill() catch {};
        self.inbuf.deinit(self.allocator);
    }

    /// Send one already-serialized JSON object as a line.
    pub fn sendRaw(self: *Sidecar, json: []const u8) void {
        if (!self.alive) return;
        const f = self.child.stdin orelse return;
        f.writeAll(json) catch {
            self.alive = false;
            return;
        };
        f.writeAll("\n") catch {
            self.alive = false;
        };
    }

    /// Send `value` serialized with std.json.
    pub fn send(self: *Sidecar, value: anytype) void {
        const json = std.json.Stringify.valueAlloc(self.allocator, value, .{}) catch return;
        defer self.allocator.free(json);
        self.sendRaw(json);
    }

    /// Forward a hook line; `payload` is CC's JSON, embedded verbatim.
    pub fn sendHook(self: *Sidecar, event: []const u8, payload: []const u8) void {
        const ev = std.json.Stringify.valueAlloc(self.allocator, event, .{}) catch return;
        defer self.allocator.free(ev);
        const body = if (payload.len == 0) "null" else payload;
        const line = std.fmt.allocPrint(self.allocator, "{{\"t\":\"hook\",\"event\":{s},\"payload\":{s}}}", .{ ev, body }) catch return;
        defer self.allocator.free(line);
        self.sendRaw(line);
    }

    /// Read what's available and hand each complete line to `onLine`.
    /// Returns false once the sidecar has exited.
    pub fn pump(self: *Sidecar, ctx: anytype, comptime onLine: fn (@TypeOf(ctx), []const u8) void) bool {
        var buf: [8192]u8 = undefined;
        const n = posix.read(self.stdoutFd(), &buf) catch return self.alive;
        if (n == 0) {
            self.alive = false;
            return false;
        }
        self.inbuf.appendSlice(self.allocator, buf[0..n]) catch return true;
        while (std.mem.indexOfScalar(u8, self.inbuf.items, '\n')) |nl| {
            onLine(ctx, self.inbuf.items[0..nl]);
            const rest = self.inbuf.items.len - (nl + 1);
            std.mem.copyForwards(u8, self.inbuf.items[0..rest], self.inbuf.items[nl + 1 ..]);
            self.inbuf.shrinkRetainingCapacity(rest);
        }
        return true;
    }
};

/// Locate `host.js`: $CLAUDE_P_JS (set by the npm shim), else relative to
/// the binary for `zig build` dev runs (zig-out/bin/../../js).
pub fn findHost(allocator: std.mem.Allocator) ?[]u8 {
    if (posix.getenv("CLAUDE_P_JS")) |dir| {
        const p = std.fs.path.join(allocator, &.{ dir, "host.js" }) catch return null;
        if (exists(p)) return p;
        allocator.free(p);
    }
    var exe_buf: [std.fs.max_path_bytes]u8 = undefined;
    const exe_dir = std.fs.selfExeDirPath(&exe_buf) catch return null;
    for ([_][]const u8{ "../../js/host.js", "../js/host.js" }) |rel| {
        const p = std.fs.path.resolve(allocator, &.{ exe_dir, rel }) catch continue;
        if (exists(p)) return p;
        allocator.free(p);
    }
    return null;
}

fn exists(path: []const u8) bool {
    std.fs.cwd().access(path, .{}) catch return false;
    return true;
}

pub fn spawn(allocator: std.mem.Allocator, host_path: []const u8, plugin_dir: ?[]const u8) !Sidecar {
    // host.js takes the `--plugin-dir` path (where pi.command stubs go) as
    // its one argument.
    var argv: [3][]const u8 = .{ "node", host_path, "" };
    const argc: usize = if (plugin_dir) |d| blk: {
        argv[2] = d;
        break :blk 3;
    } else 2;
    var child = std.process.Child.init(argv[0..argc], allocator);
    child.stdin_behavior = .Pipe;
    child.stdout_behavior = .Pipe;
    // stderr would scribble over CC's frames; host.js logs to a file instead.
    child.stderr_behavior = .Ignore;
    try child.spawn();
    return .{ .allocator = allocator, .child = child };
}
