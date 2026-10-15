import XCTest
@testable import JEVsnapCore

final class LocalDetectorTests: XCTestCase {
    private func found(_ text: String, settings: AppSettings = AppSettings()) -> [String] {
        let ns = text as NSString
        return LocalDetector(settings: settings).matches(in: text).map { ns.substring(with: $0.range) }
    }

    func testEmail() {
        XCTAssertEqual(found("contact jane.doe+x@mail.example.co.uk now"), ["jane.doe+x@mail.example.co.uk"])
        XCTAssertTrue(found("no address here @ all").isEmpty)
    }

    func testPhone() {
        XCTAssertEqual(found("call +1 (415) 555-2671 today"), ["+1 (415) 555-2671"])
        XCTAssertEqual(found("tel 415-555-2671"), ["415-555-2671"])
        // Version numbers, dates and short IPs must not look like phones.
        XCTAssertTrue(found("version 1.14.0 released 2026-10-14").isEmpty)
        XCTAssertTrue(found("build 192.168.100").isEmpty)
    }

    func testCreditCardUsesLuhn() {
        XCTAssertEqual(found("card 4242 4242 4242 4242 exp"), ["4242 4242 4242 4242"])
        XCTAssertTrue(found("order 1234 5678 9012 3456 ok").isEmpty)   // fails Luhn
    }

    func testSSN() {
        XCTAssertEqual(found("ssn 123-45-6789"), ["123-45-6789"])
        XCTAssertTrue(found("ssn 000-12-3456").isEmpty)
        XCTAssertTrue(found("ssn 900-12-3456").isEmpty)
    }

    func testIPv4() {
        XCTAssertEqual(found("server 10.20.30.40 up"), ["10.20.30.40"])
        XCTAssertTrue(found("localhost 127.0.0.1").isEmpty)
        XCTAssertTrue(found("not an ip 999.1.1.1").isEmpty)
        XCTAssertTrue(found("1.2.3.4.5").isEmpty)
    }

    func testKnownTokens() {
        let aws = "AK" + "IAIOSFODNN7EXAMPLE"
        let gh = "ghp_" + String(repeating: "a1B2", count: 9)
        let stripe = "sk_live_" + String(repeating: "x9", count: 12)
        let openai = "sk-proj-" + String(repeating: "Ab3_", count: 8)
        let slack = "xoxb-1234567890-abcdefghij"
        for t in [aws, gh, stripe, openai, slack] {
            XCTAssertEqual(found("key: \(t) end").contains(t), true, "should detect \(t)")
        }
    }

    func testJWTAndPrivateKey() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0." + "dBjftJeZ4CVPmB92K27uhbUJU1p1r"
        XCTAssertEqual(found("Authorization \(jwt)").contains(jwt), true)
        XCTAssertEqual(found("-----BEGIN RSA PRIVATE KEY-----"), ["-----BEGIN RSA PRIVATE KEY-----"])
    }

    func testBearerKeepsKeywordHidesToken() {
        XCTAssertEqual(found("Authorization: Bearer abcdef0123456789ABCDEF=="), ["abcdef0123456789ABCDEF=="])
    }

    func testCredentialAssignment() {
        XCTAssertEqual(found("DB_PASSWORD=hunter2hunter2"), ["hunter2hunter2"])
        XCTAssertEqual(found("api_key: \"abc123XYZ\""), ["abc123XYZ"])
        XCTAssertEqual(found("TYPESAFE_API_KEY=ts_abcdef"), ["ts_abcdef"])
        XCTAssertTrue(found("the password field is empty").isEmpty)
    }

    func testURLCredentials() {
        let text = "postgres://admin:s3cretPass@db.internal:5432/app"
        var only = AppSettings()
        only.enabledDetectors = [.urlCredentials]
        XCTAssertEqual(found(text, settings: only), ["s3cretPass"])
        // With every detector on, the password is still covered (the email rule also fires on user@host).
        XCTAssertTrue(found(text).contains("s3cretPass"))
    }

    func testHighEntropy() {
        let blob = "q8Zr2KxP9vLm4TnW7bYc3HdJ6sFg1AeU5oXi0"
        XCTAssertEqual(found("blob \(blob)"), [blob])
        // Git SHAs and long identifiers must not be flagged.
        XCTAssertTrue(found("commit 3f786850e387550fdab836ed7e6dc881de23001b").isEmpty)
        XCTAssertTrue(found("getUserProfileDataFromServerCacheManager").isEmpty)
    }

    func testHomePath() {
        XCTAssertEqual(found("/Users/alice/Projects/app"), ["alice"])
        XCTAssertEqual(found(#"C:\Users\Bob\Desktop"#), ["Bob"])
        XCTAssertTrue(found("/Users/Shared/data").isEmpty)
    }

    func testDetectorTogglesAreRespected() {
        var s = AppSettings()
        s.enabledDetectors = [.phone]
        XCTAssertTrue(found("a@b.com", settings: s).isEmpty)
        XCTAssertEqual(found("415-555-2671", settings: s), ["415-555-2671"])
    }

    func testCustomPhrasesRegexAndAllowlist() {
        var s = AppSettings()
        s.customPhrasesText = "Project Falcon\n"
        s.customRegexesText = "TKT-\\d{4}\n([unclosed"
        s.allowlistText = "support@mycompany.com"
        let d = LocalDetector(settings: s)
        XCTAssertEqual(d.invalidCustomRegexes, ["([unclosed"])
        let text = "about project falcon, ticket TKT-1234, mail support@mycompany.com or bob@other.org"
        let ns = text as NSString
        let hits = d.matches(in: text).map { ns.substring(with: $0.range) }
        XCTAssertEqual(Set(hits), ["project falcon", "TKT-1234", "bob@other.org"])
    }

    func testPrecompiledRulesAllCompile() {
        // Touching a detector forces every static regex to compile (they use try!).
        XCTAssertNoThrow(LocalDetector(settings: AppSettings()).matches(in: "x"))
    }
}
