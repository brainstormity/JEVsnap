import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Minimal client for TypeSafe's System One endpoint (POST /v1/systemone).
// Reference: https://docs.typesafe.ai/api and https://docs.typesafe.ai/primitives/box

public enum JevError: Error, LocalizedError, Equatable {
    case missingAPIKey
    case invalidBaseURL(String)
    case insecureBaseURL
    case unauthorized
    case rateLimited
    case overloaded
    case badRequest(String)
    case payloadTooLarge
    case server(Int, String)
    case network(String)
    case invalidResponse(String)

    public var errorDescription: String? {
        switch self {
        case .missingAPIKey: return "No TypeSafe API key is set. Add one in Settings → API."
        case .invalidBaseURL(let u): return "Invalid API base URL: \(u)"
        case .insecureBaseURL: return "Refusing to send the API key over plain HTTP. Use an https:// base URL."
        case .unauthorized: return "The TypeSafe API rejected the API key (401)."
        case .rateLimited: return "Rate limited by the TypeSafe API (429)."
        case .overloaded: return "The TypeSafe API is overloaded (529)."
        case .badRequest(let m): return "The TypeSafe API rejected the request: \(m)"
        case .payloadTooLarge: return "The request was too large for the TypeSafe API (413)."
        case .server(let code, let m): return "TypeSafe API error \(code): \(m)"
        case .network(let m): return "Network error: \(m)"
        case .invalidResponse(let m): return "Unexpected response from the TypeSafe API: \(m)"
        }
    }

    var isRetryable: Bool {
        switch self {
        case .rateLimited, .overloaded: return true
        case .server(let code, _): return code >= 500
        default: return false
        }
    }
}

public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

// A redirect must never forward screenshot contents to an unconfigured endpoint.
private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

public struct URLSessionTransport: HTTPTransport {
    public init() {}
    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let session = URLSession(configuration: .ephemeral, delegate: NoRedirectDelegate(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        return try await withCheckedThrowingContinuation { cont in
            let task = session.dataTask(with: request) { data, response, error in
                if let error = error {
                    cont.resume(throwing: error)
                } else if let http = response as? HTTPURLResponse {
                    cont.resume(returning: (data ?? Data(), http))
                } else {
                    cont.resume(throwing: JevError.invalidResponse("not an HTTP response"))
                }
            }
            task.resume()
        }
    }
}

public struct JevRequest {
    public var model: String
    public var state: JSONValue
    public var questions: [String: JSONValue]
    /// Image assets keyed by reference string; every key must appear in state/instructions/criteria.
    public var assets: [String: JSONValue]

    public init(model: String, state: JSONValue, questions: [String: JSONValue], assets: [String: JSONValue] = [:]) {
        self.model = model
        self.state = state
        self.questions = questions
        self.assets = assets
    }

    /// Images and Box questions are behind the `TypeSafe-Danger-Zone-Images` header.
    var needsImagesHeader: Bool {
        !assets.isEmpty || questions.values.contains { $0["type"]?.stringValue == "box" }
    }

    var body: JSONValue {
        var o: [String: JSONValue] = ["model": .string(model), "state": state, "questions": .object(questions)]
        if !assets.isEmpty { o["assets"] = .object(assets) }
        return .object(o)
    }
}

public enum Question {
    public static func noul(_ instructions: JSONValue, criteria: JSONValue? = nil) -> JSONValue {
        var o: [String: JSONValue] = ["type": "noul", "instructions": instructions]
        if let c = criteria { o["criteria"] = c }
        return .object(o)
    }
    public static func choice(_ instructions: JSONValue, criteria: [String: JSONValue]) -> JSONValue {
        .object(["type": "choice", "instructions": instructions, "criteria": .object(criteria)])
    }
    public static func box(_ instructions: JSONValue) -> JSONValue {
        .object(["type": "box", "instructions": instructions])
    }
}

public enum JevAnswer: Equatable {
    case noul(Double)
    case box(NormRect, confidence: Double)
    case choice(String, probabilities: [String: Double], confidence: Double)
    case score(Double, confidence: Double)
    case unknown
}

public struct JevResponse {
    public var model: String
    public var answers: [String: JevAnswer]
    public var inputTokens: Int?
    public var outputTokens: Int?
}

public struct JevClient: Sendable {
    public let apiKey: String
    public let baseURL: URL
    public let timeout: TimeInterval
    public let maxRetries: Int
    let transport: HTTPTransport
    let sleep: @Sendable (TimeInterval) async -> Void

    public init(apiKey: String,
                baseURL: String = "https://api.typesafe.ai",
                timeout: TimeInterval = 30,
                maxRetries: Int = 3,
                transport: HTTPTransport = URLSessionTransport(),
                sleep: @escaping @Sendable (TimeInterval) async -> Void = { seconds in
                    try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                }) throws {
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw JevError.missingAPIKey }
        // Header-injection guard: keys are single-line printable tokens.
        guard key.unicodeScalars.allSatisfy({ $0.value > 32 && $0.value < 127 }) else {
            throw JevError.badRequest("The API key contains invalid characters.")
        }
        guard let url = URL(string: baseURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(), let host = url.host else {
            throw JevError.invalidBaseURL(baseURL)
        }
        guard url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
            throw JevError.invalidBaseURL("Credentials, queries and fragments are not allowed")
        }
        let isLoopback = ["localhost", "127.0.0.1", "::1"].contains(host)
        guard scheme == "https" || (scheme == "http" && isLoopback) else { throw JevError.insecureBaseURL }
        self.apiKey = key
        self.baseURL = url
        self.timeout = timeout
        self.maxRetries = maxRetries
        self.transport = transport
        self.sleep = sleep
    }

    func makeRequest(path: String, method: String, body: Data?, images: Bool) -> URLRequest {
        var url = baseURL
        for part in path.split(separator: "/") { url.appendPathComponent(String(part)) }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("JEVsnap/1.0", forHTTPHeaderField: "User-Agent")
        if let body = body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if images { req.setValue("true", forHTTPHeaderField: "TypeSafe-Danger-Zone-Images") }
        return req
    }

    public func systemOne(_ request: JevRequest) async throws -> JevResponse {
        let body = try JSONEncoder().encode(request.body)
        let urlRequest = makeRequest(path: "/v1/systemone", method: "POST", body: body, images: request.needsImagesHeader)
        let data = try await perform(urlRequest)
        let response = try JevClient.parseResponse(data)
        for (id, question) in request.questions {
            guard let answer = response.answers[id] else {
                throw JevError.invalidResponse("missing or invalid answers")
            }
            let valid: Bool
            switch (question["type"]?.stringValue, answer) {
            case ("noul", .noul), ("box", .box), ("score", .score): valid = true
            case ("choice", .choice(let choice, _, _)): valid = question["criteria"]?[choice] != nil
            default: valid = false
            }
            guard valid else { throw JevError.invalidResponse("missing or invalid answers") }
        }
        return response
    }

    /// Cheap authenticated call used by Settings → "Test connection".
    public func listModels() async throws -> [String] {
        let data = try await perform(makeRequest(path: "/v1/models", method: "GET", body: nil, images: false))
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: data),
              let models = json["models"]?.arrayValue else {
            throw JevError.invalidResponse("missing models list")
        }
        return models.compactMap { $0["name"]?.stringValue }
    }

    private func perform(_ urlRequest: URLRequest) async throws -> Data {
        var attempt = 0
        while true {
            let outcome: Result<(Data, HTTPURLResponse), Error>
            do { outcome = .success(try await transport.send(urlRequest)) } catch { outcome = .failure(error) }

            switch outcome {
            case .success(let (data, http)):
                if (200..<300).contains(http.statusCode) { return data }
                let err = JevClient.error(status: http.statusCode, data: Data("Request failed. Check the API configuration and model limits.".utf8))
                guard err.isRetryable, attempt < maxRetries else { throw err }
                await sleep(JevClient.backoff(attempt: attempt, retryAfter: http.value(forHTTPHeaderField: "Retry-After")))
            case .failure(let error):
                if let jev = error as? JevError { throw jev }
                guard JevClient.isTransient(error), attempt < maxRetries else {
                    throw JevError.network(error.localizedDescription)
                }
                await sleep(JevClient.backoff(attempt: attempt, retryAfter: nil))
            }
            attempt += 1
        }
    }

    static func backoff(attempt: Int, retryAfter: String?) -> TimeInterval {
        if let s = retryAfter, let secs = Double(s.trimmingCharacters(in: .whitespaces)), secs >= 0 {
            return min(secs, 10)
        }
        return min(0.5 * pow(2, Double(attempt)), 8) + Double.random(in: 0...0.25)
    }

    static func isTransient(_ error: Error) -> Bool {
        guard let e = error as? URLError else { return false }
        return [.timedOut, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed]
            .contains(e.code)
    }

    static func error(status: Int, data: Data) -> JevError {
        let message = errorMessage(from: data)
        switch status {
        case 400, 422: return .badRequest(message)
        case 401, 403: return .unauthorized
        case 413: return .payloadTooLarge
        case 429: return .rateLimited
        case 529: return .overloaded
        default: return .server(status, message)
        }
    }

    static func errorMessage(from data: Data) -> String {
        var text = ""
        if let json = try? JSONDecoder().decode(JSONValue.self, from: data) {
            // Observed shapes: {"detail": {"error_type": "...", "message": "..."}} and {"error": {"message": "..."}}.
            if let m = json["detail"]?["message"]?.stringValue ?? json["error"]?["message"]?.stringValue
                ?? json["error"]?.stringValue ?? json["message"]?.stringValue ?? json["detail"]?.stringValue {
                text = m
            }
        }
        if text.isEmpty { text = String(decoding: data.prefix(300), as: UTF8.self) }
        return String(text.prefix(300))
    }

    static func parseResponse(_ data: Data) throws -> JevResponse {
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: data),
              let answers = json["answers"]?.objectValue else {
            throw JevError.invalidResponse("missing answers")
        }
        var parsed: [String: JevAnswer] = [:]
        for (id, a) in answers { parsed[id] = parseAnswer(a) }
        let usage = json["usage"]
        return JevResponse(model: json["model"]?.stringValue ?? "",
                           answers: parsed,
                           inputTokens: usage?["input_tokens"]?.doubleValue.flatMap { Int(exactly: $0) },
                           outputTokens: usage?["output_tokens"]?.doubleValue.flatMap { Int(exactly: $0) })
    }

    static func parseAnswer(_ a: JSONValue) -> JevAnswer {
        func probability(_ value: Double) -> Bool { value.isFinite && (0...1).contains(value) }
        let confidence = a["confidence"]?.doubleValue
        switch a["type"]?.stringValue {
        case "noul":
            if let v = a["noul"]?.doubleValue, probability(v) { return .noul(v) }
        case "box":
            if let b = a["box"],
               let l = b["left"]?.doubleValue, let t = b["top"]?.doubleValue,
               let r = b["right"]?.doubleValue, let bo = b["bottom"]?.doubleValue,
               [l, t, r, bo].allSatisfy(probability), let conf = confidence, probability(conf) {
                let rect = NormRect(left: l, top: t, right: r, bottom: bo).clamped()
                if rect.isValid { return .box(rect, confidence: conf) }
            }
        case "choice":
            if let c = a["choice"]?.stringValue, let conf = confidence, probability(conf) {
                let probs = (a["probabilities"]?.objectValue ?? [:]).compactMapValues { $0.doubleValue }
                return .choice(c, probabilities: probs, confidence: conf)
            }
        case "score":
            if let s = a["score"]?.doubleValue, s.isFinite, let conf = confidence, probability(conf) {
                return .score(s, confidence: conf)
            }
        default: break
        }
        return .unknown
    }
}
