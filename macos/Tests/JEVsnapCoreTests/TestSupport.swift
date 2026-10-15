import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import JEVsnapCore

/// Scriptable transport: records every request and answers via `handler`.
final class MockTransport: HTTPTransport, @unchecked Sendable {
    typealias Handler = (URLRequest, Int) -> (status: Int, body: Data, headers: [String: String])
    private let lock = NSLock()
    private var _requests: [URLRequest] = []
    private let handler: Handler

    init(handler: @escaping Handler) { self.handler = handler }

    var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return _requests }

    private func record(_ request: URLRequest) -> Int {
        lock.lock(); defer { lock.unlock() }
        _requests.append(request)
        return _requests.count
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let n = record(request)
        let r = handler(request, n)
        let resp = HTTPURLResponse(url: request.url!, statusCode: r.status, httpVersion: "HTTP/1.1", headerFields: r.headers)!
        return (r.body, resp)
    }
}

func jsonData(_ v: JSONValue) -> Data { try! JSONEncoder().encode(v) }

func requestJSON(_ r: URLRequest) -> JSONValue {
    try! JSONDecoder().decode(JSONValue.self, from: r.httpBody ?? Data())
}

func makeClient(_ transport: HTTPTransport, key: String = "test-key-123", retries: Int = 3) -> JevClient {
    try! JevClient(apiKey: key, baseURL: "https://api.example.test", timeout: 5, maxRetries: retries,
                   transport: transport, sleep: { _ in })
}

func ok(_ answers: [String: JSONValue]) -> (status: Int, body: Data, headers: [String: String]) {
    (200, jsonData(["model": "jev-1.14.0", "answers": .object(answers), "usage": ["input_tokens": 10, "output_tokens": 2]]), [:])
}

func line(_ text: String, row: Int, of total: Int = 20) -> OCRLine {
    let h = 1.0 / Double(total)
    let rect = NormRect(left: 0.1, top: Double(row) * h, right: 0.9, bottom: Double(row) * h + h * 0.8)
    return OCRLine(text: text, rect: rect, rangeRect: { range in
        let total = Double(max(1, (text as NSString).length))
        return NormRect(left: rect.left + 0.8 * Double(range.location) / total, top: rect.top,
                        right: rect.left + 0.8 * Double(range.location + range.length) / total, bottom: rect.bottom)
    })
}
