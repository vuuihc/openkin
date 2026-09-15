// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Kin",
    defaultLocalization: "en",
    platforms: [
        .iOS(.v17)
    ],
    targets: [
        .target(
            name: "Kin",
            path: "Kin",
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "KinTests",
            dependencies: ["Kin"],
            path: "KinTests"
        ),
    ]
)