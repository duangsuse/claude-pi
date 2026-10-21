//! Live transcript tailing. Used by the driver to emit Claude's session
//! JSONL transcript to stdout as it grows, giving us per-message streaming
//! output (the same granularity `claude -p --output-format stream-json`
//! produces).
//!
//! The transcript file is being written by the child `claude` process while
//! we read from it. We use `pread` so we never disturb the file's own offset
//! (Claude appends; we read from our own cursor) and we buffer incomplete
//! trailing fragments until the newline arrives.
const std = @import("std");

pub const Tailer = struct {
    allocator: std.mem.Allocator,
    file: std.fs.File,
    pos: u64 = 0,
    /// Bytes read past the last newline. We hold them until the line
    /// completes so callers never see torn JSON.
    partial: std.ArrayList(u8) = .{},

    /// Open a file path for tailing. Caller owns the returned Tailer and must
    /// call `deinit`.
    pub fn open(allocator: std.mem.Allocator, path: []const u8) !Tailer {
        const file = try std.fs.cwd().openFile(path, .{});
        return .{ .allocator = allocator, .file = file };
    }

    pub fn deinit(self: *Tailer) void {
        self.file.close();
        self.partial.deinit(self.allocator);
    }

    /// Read any newly-available bytes from the file and emit every complete
    /// line (including its trailing `\n`) to `writer`. Returns the number of
    /// complete lines emitted. Does not block: when the file has no new
    /// bytes, returns 0.
    pub fn pump(self: *Tailer, writer: *std.Io.Writer) !usize {
        var buf: [4096]u8 = undefined;
        var emitted: usize = 0;
        while (true) {
            const n = try std.posix.pread(self.file.handle, &buf, self.pos);
            if (n == 0) break;
            self.pos += n;
            try self.partial.appendSlice(self.allocator, buf[0..n]);
            while (std.mem.indexOfScalar(u8, self.partial.items, '\n')) |nl| {
                const line_end = nl + 1;
                try writer.writeAll(self.partial.items[0..line_end]);
                emitted += 1;
                const rest_len = self.partial.items.len - line_end;
                if (rest_len > 0) {
                    std.mem.copyForwards(
                        u8,
                        self.partial.items[0..rest_len],
                        self.partial.items[line_end..],
                    );
                }
                self.partial.shrinkRetainingCapacity(rest_len);
            }
            if (n < buf.len) break;
        }
        return emitted;
    }

    /// Emit any trailing partial line (one without a final `\n`). Useful at
    /// session end if a writer didn't flush. After this call the internal
    /// buffer is empty.
    pub fn flushPartial(self: *Tailer, writer: *std.Io.Writer) !void {
        if (self.partial.items.len > 0) {
            try writer.writeAll(self.partial.items);
            self.partial.clearRetainingCapacity();
        }
    }
};

// -------- tests --------

const testing = std.testing;

test "Tailer: emits a single line written before open" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();

    var f = try tmp.dir.createFile("t.jsonl", .{ .read = true });
    try f.writeAll("{\"a\":1}\n");
    f.close();

    const path = try tmp.dir.realpathAlloc(testing.allocator, "t.jsonl");
    defer testing.allocator.free(path);

    var t = try Tailer.open(testing.allocator, path);
    defer t.deinit();

    var buf: std.ArrayList(u8) = .{};
    defer buf.deinit(testing.allocator);
    var aw = std.Io.Writer.Allocating.fromArrayList(testing.allocator, &buf);
    const n = try t.pump(&aw.writer);
    buf = aw.toArrayList();

    try testing.expectEqual(@as(usize, 1), n);
    try testing.expectEqualStrings("{\"a\":1}\n", buf.items);
}

test "Tailer: tails appended lines across multiple pumps" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();

    var f = try tmp.dir.createFile("t.jsonl", .{ .read = true, .truncate = true });
    defer f.close();
    try f.writeAll("line1\n");

    const path = try tmp.dir.realpathAlloc(testing.allocator, "t.jsonl");
    defer testing.allocator.free(path);

    var t = try Tailer.open(testing.allocator, path);
    defer t.deinit();

    var buf: std.ArrayList(u8) = .{};
    defer buf.deinit(testing.allocator);
    var aw = std.Io.Writer.Allocating.fromArrayList(testing.allocator, &buf);

    _ = try t.pump(&aw.writer);
    buf = aw.toArrayList();
    try testing.expectEqualStrings("line1\n", buf.items);

    try f.writeAll("line2\n");
    var aw2 = std.Io.Writer.Allocating.fromArrayList(testing.allocator, &buf);
    _ = try t.pump(&aw2.writer);
    buf = aw2.toArrayList();
    try testing.expectEqualStrings("line1\nline2\n", buf.items);
}

test "Tailer: holds back partial line until newline arrives" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();

    var f = try tmp.dir.createFile("t.jsonl", .{ .read = true, .truncate = true });
    defer f.close();
    try f.writeAll("hello, ");

    const path = try tmp.dir.realpathAlloc(testing.allocator, "t.jsonl");
    defer testing.allocator.free(path);

    var t = try Tailer.open(testing.allocator, path);
    defer t.deinit();

    var buf: std.ArrayList(u8) = .{};
    defer buf.deinit(testing.allocator);
    var aw = std.Io.Writer.Allocating.fromArrayList(testing.allocator, &buf);

    var lines = try t.pump(&aw.writer);
    buf = aw.toArrayList();
    try testing.expectEqual(@as(usize, 0), lines);
    try testing.expectEqual(@as(usize, 0), buf.items.len);

    try f.writeAll("world!\n");
    var aw2 = std.Io.Writer.Allocating.fromArrayList(testing.allocator, &buf);
    lines = try t.pump(&aw2.writer);
    buf = aw2.toArrayList();
    try testing.expectEqual(@as(usize, 1), lines);
    try testing.expectEqualStrings("hello, world!\n", buf.items);
}

test "Tailer: emits multiple lines in a single pump" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();

    var f = try tmp.dir.createFile("t.jsonl", .{ .read = true, .truncate = true });
    try f.writeAll("a\nb\nc\n");
    f.close();

    const path = try tmp.dir.realpathAlloc(testing.allocator, "t.jsonl");
    defer testing.allocator.free(path);

    var t = try Tailer.open(testing.allocator, path);
    defer t.deinit();

    var buf: std.ArrayList(u8) = .{};
    defer buf.deinit(testing.allocator);
    var aw = std.Io.Writer.Allocating.fromArrayList(testing.allocator, &buf);
    const n = try t.pump(&aw.writer);
    buf = aw.toArrayList();
    try testing.expectEqual(@as(usize, 3), n);
    try testing.expectEqualStrings("a\nb\nc\n", buf.items);
}

test "Tailer: flushPartial emits trailing fragment" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();

    var f = try tmp.dir.createFile("t.jsonl", .{ .read = true, .truncate = true });
    try f.writeAll("done\nincomplete");
    f.close();

    const path = try tmp.dir.realpathAlloc(testing.allocator, "t.jsonl");
    defer testing.allocator.free(path);

    var t = try Tailer.open(testing.allocator, path);
    defer t.deinit();

    var buf: std.ArrayList(u8) = .{};
    defer buf.deinit(testing.allocator);
    var aw = std.Io.Writer.Allocating.fromArrayList(testing.allocator, &buf);
    _ = try t.pump(&aw.writer);
    try t.flushPartial(&aw.writer);
    buf = aw.toArrayList();
    try testing.expectEqualStrings("done\nincomplete", buf.items);
}
