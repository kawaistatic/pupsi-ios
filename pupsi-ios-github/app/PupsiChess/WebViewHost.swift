// Pupsi Chess - WKWebView host, script injection and URL scheme bridge
import SwiftUI
import WebKit

struct WebViewHost: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(PupsiSchemeHandler(), forURLScheme: "pupsi")
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController = context.coordinator.controller

        // Order matters: shim -> styles -> engine.
        if let shim = resource("pupsi-shim", "js") {
            add(shim, to: context.coordinator.controller, at: .atDocumentStart, mainFrame: false)
        }
        if let css = resource("styles", "css") {
            let js = "(()=>{var s=document.createElement('style');s.id='pupsi-styles';s.textContent="
                + css.jsQuoted + ";(document.head||document.documentElement).appendChild(s)})();"
            add(js, to: context.coordinator.controller, at: .atDocumentEnd, mainFrame: true)
        }
        if let engine = resource("content", "js") {
            add(engine, to: context.coordinator.controller, at: .atDocumentEnd, mainFrame: true)
        }

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        web.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.webView = web
        web.load(URLRequest(url: URL(string: "https://www.chess.com/")!))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    private func resource(_ name: String, _ ext: String) -> String? {
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("Resources", isDirectory: true) else {
            return nil
        }
        let url = root.appendingPathComponent(name).appendingPathExtension(ext)
        return try? String(contentsOf: url, encoding: .utf8)
    }

    private func add(_ source: String, to controller: WKUserContentController,
                     at time: WKUserScriptInjectionTime, mainFrame: Bool) {
        controller.addUserScript(WKUserScript(source: source,
                                              injectionTime: time,
                                              forMainFrameOnly: mainFrame))
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        let controller = WKUserContentController()
        weak var webView: WKWebView?
    }
}

extension String {
    /// Escape a Swift string for embedding inside a JavaScript string literal.
    var jsQuoted: String {
        var out = "\""
        for ch in self {
            switch ch {
            case "\\": out += "\\\\"
            case "\"": out += "\\\""
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{2028}": out += "\\u2028"
            case "\u{2029}": out += "\\u2029"
            default: out.append(ch)
            }
        }
        return out + "\""
    }
}
