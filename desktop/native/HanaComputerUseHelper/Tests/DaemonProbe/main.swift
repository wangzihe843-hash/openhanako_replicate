import CuaDriverServer
import Foundation

// No AppKit bootstrap, configuration loading, permission probes, or UI tools.
// The explicit root/path contract keeps this fixture off real helper sockets.
@main
struct DaemonProbe {
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let root = ProcessInfo.processInfo.environment["HANA_DAEMON_TEST_ROOT"],
              URL(fileURLWithPath: root).lastPathComponent.hasPrefix("hana-daemon-test-"),
              let socketPath = args.first,
              URL(fileURLWithPath: socketPath).deletingLastPathComponent().path == root else {
            fputs("An isolated test root and socket are required.\n", stderr)
            exit(64)
        }
        let pidFile = args.count > 1 ? args[1] : nil
        guard pidFile == nil || pidFile!.hasPrefix(root + "/") else { exit(64) }
        do {
            try await DaemonServer(socketPath: socketPath, pidFilePath: pidFile,
                                   registry: ToolRegistry(handlers: [])).run()
        } catch {
            fputs("daemon test probe: \(error)\n", stderr)
            exit(70)
        }
    }
}
