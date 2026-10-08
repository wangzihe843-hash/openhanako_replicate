import Darwin
import Foundation

/// Patched into CuaDriverServer by build-computer-use-helper.mjs. Keep the
/// lock inode for the whole daemon lifetime, including startup rollback.
/// The lock file is deliberately never unlinked: doing so splits flock users
/// between two inodes. A dead process releases its flock automatically.
final class HanaDaemonSocketLease {
    private struct Identity: Equatable {
        let device: dev_t
        let inode: ino_t
        let kind: mode_t
        let owner: uid_t

        init(_ info: stat) {
            device = info.st_dev
            inode = info.st_ino
            kind = info.st_mode & mode_t(S_IFMT)
            owner = info.st_uid
        }
    }

    private let socketPath: String
    private let lockPath: String
    private var lockFD: Int32 = -1
    private var lockIdentity: Identity?
    private var socketIdentity: Identity?
    private var pidFile: (path: String, identity: Identity)?

    init(socketPath: String) throws {
        self.socketPath = socketPath
        self.lockPath = socketPath + ".lock"
        // Validate before touching an existing endpoint.
        _ = try Self.address(socketPath)
        let fd = open(lockPath, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw Failure("open lock", errno) }
        do {
            var info = stat()
            guard fstat(fd, &info) == 0 else { throw Failure("stat lock", errno) }
            let identity = Identity(info)
            guard identity.kind == mode_t(S_IFREG), identity.owner == geteuid() else {
                throw Failure("lock is not an owned regular file", 0)
            }
            guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
                throw Failure("daemon socket is already owned", errno)
            }
            guard try Self.identity(at: lockPath) == identity else {
                throw Failure("lock pathname changed", 0)
            }
            lockIdentity = identity
            lockFD = fd
        } catch {
            close(fd)
            throw error
        }
    }

    deinit { release() }

    func prepareForBind() throws {
        try requireLock()
        guard let previous = try Self.identity(at: socketPath) else { return }
        guard previous.kind == mode_t(S_IFSOCK), previous.owner == geteuid() else {
            throw Failure("refusing to remove a non-owned socket", 0)
        }

        // An older helper may not know about this lock. Refuse a live socket
        // even when we acquired the lock; only ECONNREFUSED/ENOENT prove a
        // stale endpoint. In-progress connects and other errors fail closed.
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw Failure("probe socket", errno) }
        defer { close(fd) }
        guard fcntl(fd, F_SETFL, O_NONBLOCK) == 0 else { throw Failure("probe flags", errno) }
        var address = try Self.address(socketPath)
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        let connectError = errno
        guard result != 0, connectError == ECONNREFUSED || connectError == ENOENT else {
            throw Failure("existing socket is live or cannot be proved stale", result == 0 ? 0 : connectError)
        }
        try requireLock()
        guard try Self.identity(at: socketPath) == previous else {
            throw Failure("socket changed during stale check", 0)
        }
        guard unlink(socketPath) == 0 else { throw Failure("unlink stale socket", errno) }
    }

    func recordBoundSocket() throws {
        try requireLock()
        guard let identity = try Self.identity(at: socketPath),
              identity.kind == mode_t(S_IFSOCK), identity.owner == geteuid() else {
            throw Failure("bound socket pathname changed", 0)
        }
        socketIdentity = identity
    }

    func recordPidFile(_ path: String) throws {
        try requireLock()
        guard let identity = try Self.identity(at: path),
              identity.kind == mode_t(S_IFREG), identity.owner == geteuid() else {
            throw Failure("pid file pathname changed", 0)
        }
        pidFile = (path, identity)
    }

    func release() {
        guard lockFD >= 0 else { return }
        // Replacement paths belong to somebody else. Keep the lock until
        // all conditional cleanup has finished; never delete the lock file.
        if (try? requireLock()) != nil {
            if let socketIdentity, (try? Self.identity(at: socketPath)) == socketIdentity {
                _ = unlink(socketPath)
            }
            if let pidFile, (try? Self.identity(at: pidFile.path)) == pidFile.identity {
                _ = unlink(pidFile.path)
            }
        }
        close(lockFD)
        lockFD = -1
        socketIdentity = nil
        pidFile = nil
    }

    private func requireLock() throws {
        guard lockFD >= 0, let lockIdentity,
              try Self.identity(at: lockPath) == lockIdentity else {
            throw Failure("daemon lock ownership was lost", 0)
        }
    }

    private static func identity(at path: String) throws -> Identity? {
        var info = stat()
        if lstat(path, &info) == 0 { return Identity(info) }
        if errno == ENOENT { return nil }
        throw Failure("lstat", errno)
    }

    private static func address(_ path: String) throws -> sockaddr_un {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard !bytes.isEmpty, !bytes.contains(0), bytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
            throw Failure("invalid socket pathname", 0)
        }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            for (index, byte) in bytes.enumerated() { raw[index] = byte }
            raw[bytes.count] = 0
        }
        return address
    }

    private struct Failure: Error, CustomStringConvertible {
        let operation: String
        let code: Int32

        init(_ operation: String, _ code: Int32) {
            self.operation = operation
            self.code = code
        }

        var description: String { "\(operation) (errno \(code))" }
    }
}
