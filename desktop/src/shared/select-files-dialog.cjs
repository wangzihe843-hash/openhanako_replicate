/**
 * select-files IPC dialog options.
 *
 * Windows/Linux: showOpenDialog 不支持同一 dialog 同时选 file 和 directory,
 * 必须留在 openFile-only。该函数只负责构造 dialog options,IPC handler 调
 * showOpenDialog 后自行 unwrap result.filePaths。
 */
function buildSelectFilesDialogOptions({ title } = {}) {
  return {
    properties: ["openFile", "multiSelections"],
    title: title || "Select Files",
  };
}

module.exports = {
  buildSelectFilesDialogOptions,
};
