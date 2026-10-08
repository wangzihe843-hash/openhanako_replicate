// Pinned CuaDriverServer lacks ownership checks when used without its CLI.
// Hana calls DaemonServer directly, so put the lease inside the server itself.
export function patchCuaDriverDaemonServerSource(source) {
  const sentinel = "private var hanaSocketLease: HanaDaemonSocketLease?";
  const protocol = 'public static let hanaOwnershipProtocol = "hana-daemon-ownership-v1"';
  if (source.includes(sentinel) && source.includes(protocol)) return source;
  let patched = source;
  const replace = (before, after) => {
    if (!patched.includes(before)) {
      throw new Error("[computer-use-helper] Cua daemon ownership patch anchor not found");
    }
    patched = patched.replace(before, after);
  };

  replace("public actor DaemonServer {", `public actor DaemonServer {
    ${protocol}`);
  replace("    private var listenFD: Int32 = -1", `    private var listenFD: Int32 = -1
    ${sentinel}`);
  replace(`        removeStaleSocketFile()
        try bindListener()
        try createShutdownPipe()
        try writePidFile()`, `        let socketLease = try HanaDaemonSocketLease(socketPath: socketPath)
        hanaSocketLease = socketLease
        defer {
            if listenFD >= 0 { close(listenFD); listenFD = -1 }
            if pipeReadFD >= 0 { close(pipeReadFD); pipeReadFD = -1 }
            if pipeWriteFD >= 0 { close(pipeWriteFD); pipeWriteFD = -1 }
            socketLease.release()
            hanaSocketLease = nil
        }
        try socketLease.prepareForBind()
        try bindListener()
        try createShutdownPipe()
        try writePidFile()
        if let pidFilePath { try socketLease.recordPidFile(pidFilePath) }`);
  replace(`        let socketPathSnapshot = self.socketPath
        let pidFileSnapshot = self.pidFilePath
`, "");
  replace(`                // acceptLoopStatic only returns once shutdown is requested.
                // Clean up filesystem artifacts and wake run().
                Self.cleanupFilesystem(
                    socketPath: socketPathSnapshot, pidFilePath: pidFileSnapshot
                )`, `                // run() owns filesystem cleanup and the write end of the pipe.
                // The accept loop has already closed the listener/read end.`);
  replace(`    fileprivate func notifyShutdown() {
`, `    fileprivate func notifyShutdown() {
        listenFD = -1
        pipeReadFD = -1
`);
  replace(`    private func removeStaleSocketFile() {
        // Any prior bind leaves the socket file in place even after the
        // owning process dies. Must unlink before bind() or the kernel
        // returns EADDRINUSE.
        _ = unlink(socketPath)
    }

`, "");
  replace(`        // 0600 — only the owning user gets to talk to this socket.`, `        do {
            try hanaSocketLease?.recordBoundSocket()
        } catch {
            close(fd)
            throw error
        }

        // 0600 — only the owning user gets to talk to this socket.`);
  replace(`            _ = unlink(socketPath)
            throw DaemonError.systemCall("listen", errno: savedErrno)`, `            throw DaemonError.systemCall("listen", errno: savedErrno)`);
  replace(`    fileprivate static func cleanupFilesystem(
        socketPath: String, pidFilePath: String?
    ) {
        _ = unlink(socketPath)
        if let pidFilePath {
            _ = unlink(pidFilePath)
        }
    }
`, "");
  replace(`        switch request.method {
`, `        if request.method == "hana_instance" {
            let instanceId = ProcessInfo.processInfo.environment["HANA_COMPUTER_USE_INSTANCE_ID"]
            return DaemonResponse(ok: instanceId?.isEmpty == false && request.name == instanceId)
        }
        switch request.method {
`);
  return patched;
}
