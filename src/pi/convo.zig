//! Moving a CC conversation aside on Ctrl+C exit. A session is
//! `<config>/projects/<project>/<session>.jsonl` plus, when CC needed it, a
//! sibling `<session>/` directory (subagent transcripts, tool results).
//! It goes to `~/claude/last` (+ `last.d`), replacing the previous one, and
//! a `mv` back restores it.
const std = @import("std");

/// Only touch what is unmistakably a CC transcript: `…/projects/<p>/<s>.jsonl`.
pub fn isTranscript(path: []const u8) bool {
    if (!std.fs.path.isAbsolute(path) or !std.mem.endsWith(u8, path, ".jsonl")) return false;
    if (std.mem.indexOf(u8, path, "/../") != null or std.mem.indexOf(u8, path, "/./") != null) return false;
    const project = std.fs.path.dirname(path) orelse return false;
    const projects = std.fs.path.dirname(project) orelse return false;
    return std.mem.eql(u8, std.fs.path.basename(projects), "projects") and
        std.fs.path.basename(path).len > ".jsonl".len;
}

/// Whether the transcript has a user message (CC writes compact JSON).
pub fn hasMessages(path: []const u8) bool {
    const f = std.fs.openFileAbsolute(path, .{}) catch return false;
    defer f.close();
    var buf: [64 * 1024]u8 = undefined;
    var keep: usize = 0; // tail of the previous read, for a match across reads
    const needle = "\"type\":\"user\"";
    while (true) {
        const n = f.read(buf[keep..]) catch return false;
        if (n == 0) return false;
        const got = buf[0 .. keep + n];
        if (std.mem.indexOf(u8, got, needle) != null) return true;
        keep = @min(got.len, needle.len - 1);
        std.mem.copyForwards(u8, buf[0..keep], got[got.len - keep ..]);
    }
}

/// Move the transcript to `<last>` and its session directory (if any) to
/// `<last>.d`, replacing what was there. Returns the shell line that
/// restores it (`mv … && mv …`), or null when nothing was moved: not a
/// transcript, an empty session (no user message, left alone), or the move
/// failed. Caller frees. `shown` is how `last` is printed (`~/claude/last`).
pub fn stash(a: std.mem.Allocator, path: []const u8, last: []const u8, shown: []const u8) ?[]u8 {
    if (!isTranscript(path) or !hasMessages(path)) return null;
    const dir = path[0 .. path.len - ".jsonl".len];
    const last_d = std.fmt.allocPrint(a, "{s}.d", .{last}) catch return null;
    defer a.free(last_d);
    if (std.fs.path.dirname(last)) |p| std.fs.cwd().makePath(p) catch {};
    std.fs.deleteTreeAbsolute(last) catch {};
    std.fs.deleteTreeAbsolute(last_d) catch {};
    std.fs.renameAbsolute(path, last) catch return null;
    const has_dir = if (std.fs.renameAbsolute(dir, last_d)) true else |_| false;
    return if (has_dir)
        std.fmt.allocPrint(a, "mv {s} {s} && mv {s}.d {s}", .{ shown, path, shown, dir }) catch null
    else
        std.fmt.allocPrint(a, "mv {s} {s}", .{ shown, path }) catch null;
}

// -------- tests --------

const testing = std.testing;

test "isTranscript" {
    try testing.expect(isTranscript("/home/u/.claude/projects/-home-u-p/0b1c.jsonl"));
    try testing.expect(!isTranscript("/home/u/.claude/projects/-home-u-p/0b1c.json"));
    try testing.expect(!isTranscript("/home/u/.claude/history.jsonl"));
    try testing.expect(!isTranscript("/home/u/.claude/projects/x.jsonl"));
    try testing.expect(!isTranscript("relative/projects/p/s.jsonl"));
    try testing.expect(!isTranscript("/home/u/.claude/projects/p/../../settings.jsonl"));
    try testing.expect(!isTranscript("/home/u/.claude/projects/p/.jsonl"));
}

test "stash moves a session aside and says how to restore it" {
    const a = testing.allocator;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.makePath("projects/proj/sess/subagents");
    try tmp.dir.writeFile(.{ .sub_path = "projects/proj/sess.jsonl", .data = "{\"type\":\"user\",\"message\":{}}\n" });
    try tmp.dir.writeFile(.{ .sub_path = "projects/proj/empty.jsonl", .data = "{\"type\":\"summary\"}\n" });
    try tmp.dir.makePath("claude/last.d");
    const root = try tmp.dir.realpathAlloc(a, ".");
    defer a.free(root);
    const path = try std.fmt.allocPrint(a, "{s}/projects/proj/sess.jsonl", .{root});
    defer a.free(path);
    const empty = try std.fmt.allocPrint(a, "{s}/projects/proj/empty.jsonl", .{root});
    defer a.free(empty);
    const last = try std.fmt.allocPrint(a, "{s}/claude/last", .{root});
    defer a.free(last);

    try testing.expect(stash(a, empty, last, "~/claude/last") == null);
    try tmp.dir.access("projects/proj/empty.jsonl", .{});

    const restore = stash(a, path, last, "~/claude/last").?;
    defer a.free(restore);
    const want = try std.fmt.allocPrint(a, "mv ~/claude/last {s} && mv ~/claude/last.d {s}/projects/proj/sess", .{ path, root });
    defer a.free(want);
    try testing.expectEqualStrings(want, restore);
    try testing.expectError(error.FileNotFound, tmp.dir.access("projects/proj/sess.jsonl", .{}));
    try tmp.dir.access("claude/last", .{});
    try tmp.dir.access("claude/last.d/subagents", .{});
}
