//! Deleting a CC conversation on Ctrl+C exit. A session is
//! `<config>/projects/<project>/<session>.jsonl` plus, when CC needed it, a
//! sibling `<session>/` directory (subagent transcripts, tool results).
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

/// Delete the transcript and its session directory. Returns whether the
/// transcript was removed.
pub fn delete(path: []const u8) bool {
    if (!isTranscript(path)) return false;
    std.fs.deleteFileAbsolute(path) catch return false;
    const dir = path[0 .. path.len - ".jsonl".len];
    std.fs.deleteTreeAbsolute(dir) catch {};
    return true;
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

test "delete removes the transcript and its session dir only" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.makePath("projects/proj/sess/subagents");
    try tmp.dir.writeFile(.{ .sub_path = "projects/proj/sess.jsonl", .data = "{}\n" });
    try tmp.dir.writeFile(.{ .sub_path = "projects/proj/other.jsonl", .data = "{}\n" });
    const root = try tmp.dir.realpathAlloc(testing.allocator, ".");
    defer testing.allocator.free(root);
    const path = try std.fmt.allocPrint(testing.allocator, "{s}/projects/proj/sess.jsonl", .{root});
    defer testing.allocator.free(path);

    try testing.expect(delete(path));
    try testing.expectError(error.FileNotFound, tmp.dir.access("projects/proj/sess.jsonl", .{}));
    try testing.expectError(error.FileNotFound, tmp.dir.access("projects/proj/sess", .{}));
    try tmp.dir.access("projects/proj/other.jsonl", .{});
    try testing.expect(!delete(path)); // already gone
}
