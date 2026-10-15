// swift-tools-version:5.9
import PackageDescription

// JEVsnapCore is platform-independent (no AppKit/Vision) so its logic is unit-tested
// on any OS. The menu-bar app target only exists on macOS.
var targets: [Target] = [
    .target(name: "JEVsnapCore", path: "Sources/JEVsnapCore"),
    .testTarget(name: "JEVsnapCoreTests", dependencies: ["JEVsnapCore"], path: "Tests/JEVsnapCoreTests"),
]
var products: [Product] = [
    .library(name: "JEVsnapCore", targets: ["JEVsnapCore"]),
]

#if os(macOS)
targets.append(
    .executableTarget(name: "JEVsnap", dependencies: ["JEVsnapCore"], path: "Sources/JEVsnap")
)
products.append(.executable(name: "JEVsnap", targets: ["JEVsnap"]))
#endif

let package = Package(
    name: "JEVsnap",
    platforms: [.macOS(.v13)],
    products: products,
    targets: targets
)
