// Pupsi Chess - serves bundled engine files under pupsi://local/
import WebKit

final class PupsiSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else { return }
        var path = url.path
        if path.hasPrefix("/") { path = String(path.dropFirst()) }

        guard let root = Bundle.main.resourceURL?.appendingPathComponent("Resources", isDirectory: true),
              FileManager.default.fileExists(atPath: root.path) else {
            fail(urlSchemeTask, status: 500); return
        }
        let file = root.appendingPathComponent(path)

        // Contain requests inside the bundle directory.
        let standardized = file.standardizedFileURL.path
        guard standardized.hasPrefix(root.standardizedFileURL.path + "/") else {
            fail(urlSchemeTask, status: 403); return
        }
        guard let data = try? Data(contentsOf: file) else {
            fail(urlSchemeTask, status: 404); return
        }

        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": mimeType(file.pathExtension),
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-store"
            ]
        )!
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func fail(_ task: WKURLSchemeTask, status: Int) {
        let url = task.request.url ?? URL(string: "pupsi://local/")!
        let response = HTTPURLResponse(url: url, statusCode: status,
                                       httpVersion: "HTTP/1.1", headerFields: nil)!
        task.didReceive(response)
        task.didFinish()
    }

    private func mimeType(_ ext: String) -> String {
        switch ext.lowercased() {
        case "js": return "application/javascript; charset=utf-8"
        case "wasm": return "application/wasm"
        case "css": return "text/css; charset=utf-8"
        case "html": return "text/html; charset=utf-8"
        case "png": return "image/png"
        case "svg": return "image/svg+xml"
        default: return "application/octet-stream"
        }
    }
}
