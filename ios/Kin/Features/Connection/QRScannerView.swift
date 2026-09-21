import SwiftUI
@preconcurrency import AVFoundation

/// Camera-based QR code scanner wrapped as a SwiftUI view via `UIViewControllerRepresentable`.
///
/// On a successful scan, dismisses itself and calls `onScan` with the raw URL string.
/// On simulator, presents a manual text-entry fallback overlay since the camera is unavailable.
struct QRScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void
    let onCancel: () -> Void

    func makeUIViewController(context: Context) -> UIViewController {
        #if targetEnvironment(simulator)
        return SimulatorQRViewController(onScan: onScan, onCancel: onCancel)
        #else
        let controller = CameraQRViewController()
        controller.onScan = onScan
        controller.onCancel = onCancel
        return controller
        #endif
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {
        // No-op: configuration is set at creation time.
    }
}

// MARK: - Camera-based implementation

#if !targetEnvironment(simulator)
private final class CameraQRViewController: UIViewController {
    var onScan: ((String) -> Void)?
    var onCancel: (() -> Void)?

    private let captureSession = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "dev.openkin.ios.qr-session", qos: .userInitiated)
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var hasScanned = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        setupCancelButton()
        checkAuthorization()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.layer.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stopSession()
    }

    // MARK: - Authorization

    private func checkAuthorization() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            startSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted {
                        self?.startSession()
                    } else {
                        self?.showUnauthorizedAlert()
                    }
                }
            }
        default:
            showUnauthorizedAlert()
        }
    }

    private func showUnauthorizedAlert() {
        DispatchQueue.main.async { [weak self] in
            let alert = UIAlertController(
                title: "Camera Access Required",
                message: "Please enable camera access in Settings to scan QR codes.",
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
                self?.onCancel?()
            })
            self?.present(alert, animated: true)
        }
    }

    // MARK: - Session

    private func startSession() {
        let captureSession = captureSession
        sessionQueue.async { [weak self, captureSession] in
            guard let self else { return }

            if captureSession.inputs.isEmpty && captureSession.outputs.isEmpty {
                guard let captureDevice = AVCaptureDevice.default(for: .video),
                      let input = try? AVCaptureDeviceInput(device: captureDevice)
                else {
                    DispatchQueue.main.async { self.showUnauthorizedAlert() }
                    return
                }

                captureSession.beginConfiguration()
                if captureSession.canAddInput(input) {
                    captureSession.addInput(input)
                } else {
                    captureSession.commitConfiguration()
                    DispatchQueue.main.async { self.showUnauthorizedAlert() }
                    return
                }

                let output = AVCaptureMetadataOutput()
                guard captureSession.canAddOutput(output) else {
                    captureSession.commitConfiguration()
                    DispatchQueue.main.async { self.showUnauthorizedAlert() }
                    return
                }
                captureSession.addOutput(output)
                guard output.availableMetadataObjectTypes.contains(.qr) else {
                    captureSession.commitConfiguration()
                    DispatchQueue.main.async { self.showUnauthorizedAlert() }
                    return
                }
                output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
                output.metadataObjectTypes = [.qr]
                captureSession.commitConfiguration()
            }

            DispatchQueue.main.async { [weak self] in
                self?.addPreviewLayer()
            }
            if !captureSession.isRunning {
                captureSession.startRunning()
            }
        }
    }

    private func stopSession() {
        let captureSession = captureSession
        sessionQueue.async { [captureSession] in
            guard captureSession.isRunning else { return }
            captureSession.stopRunning()
        }
    }

    private func addPreviewLayer() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard self.previewLayer == nil else { return }
            let layer = AVCaptureVideoPreviewLayer(session: self.captureSession)
            layer.videoGravity = .resizeAspectFill
            layer.frame = self.view.layer.bounds
            self.view.layer.insertSublayer(layer, at: 0)
            self.previewLayer = layer
        }
    }

    // MARK: - Cancel button

    private func setupCancelButton() {
        let button = UIButton(type: .system)
        button.setTitle("Cancel", for: .normal)
        button.setTitleColor(.white, for: .normal)
        button.titleLabel?.font = UIFont.boldSystemFont(ofSize: 17)
        button.backgroundColor = UIColor.black.withAlphaComponent(0.5)
        button.layer.cornerRadius = 12
        button.translatesAutoresizingMaskIntoConstraints = false
        button.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)

        view.addSubview(button)

        NSLayoutConstraint.activate([
            button.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            button.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -40),
            button.widthAnchor.constraint(equalToConstant: 120),
            button.heightAnchor.constraint(equalToConstant: 44),
        ])
    }

    @objc private func cancelTapped() {
        onCancel?()
    }
}

// MARK: - AVCaptureMetadataOutputObjectsDelegate

extension CameraQRViewController: @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !hasScanned else { return }
        guard let metadataObject = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let stringValue = metadataObject.stringValue
        else { return }

        hasScanned = true
        stopSession()
        DispatchQueue.main.async { [weak self] in
            self?.onScan?(stringValue)
        }
    }
}
#endif

// MARK: - Simulator fallback

#if targetEnvironment(simulator)
private final class SimulatorQRViewController: UIViewController {
    private let onScan: (String) -> Void
    private let onCancel: () -> Void

    init(onScan: @escaping (String) -> Void, onCancel: @escaping () -> Void) {
        self.onScan = onScan
        self.onCancel = onCancel
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        setupUI()
    }

    private func setupUI() {
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 16
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false

        let icon = UIImageView(image: UIImage(systemName: "qrcode.viewfinder"))
        icon.tintColor = .secondaryLabel
        icon.contentMode = .scaleAspectFit
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 64).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 64).isActive = true

        let label = UILabel()
        label.text = "Simulator QR Scanner"
        label.font = UIFont.boldSystemFont(ofSize: 20)
        label.textAlignment = .center

        let note = UILabel()
        note.text = "Camera is unavailable in the simulator.\nEnter the pairing URL manually below."
        note.font = UIFont.systemFont(ofSize: 15)
        note.textColor = .secondaryLabel
        note.textAlignment = .center
        note.numberOfLines = 0

        let textField = UITextField()
        textField.placeholder = "Paste QR code URL here"
        textField.borderStyle = .roundedRect
        textField.autocapitalizationType = .none
        textField.autocorrectionType = .no
        textField.translatesAutoresizingMaskIntoConstraints = false

        let submitButton = UIButton(type: .system)
        submitButton.setTitle("Submit", for: .normal)
        submitButton.titleLabel?.font = UIFont.boldSystemFont(ofSize: 17)
        submitButton.backgroundColor = .tintColor
        submitButton.setTitleColor(.white, for: .normal)
        submitButton.layer.cornerRadius = 12
        submitButton.translatesAutoresizingMaskIntoConstraints = false
        submitButton.addTarget(self, action: #selector(submitTapped), for: .touchUpInside)

        let cancelButton = UIButton(type: .system)
        cancelButton.setTitle("Cancel", for: .normal)
        cancelButton.titleLabel?.font = UIFont.systemFont(ofSize: 17)
        cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)

        stack.addArrangedSubview(icon)
        stack.addArrangedSubview(label)
        stack.addArrangedSubview(note)
        stack.addArrangedSubview(textField)
        stack.addArrangedSubview(submitButton)
        stack.addArrangedSubview(cancelButton)

        view.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -32),
            textField.leadingAnchor.constraint(equalTo: stack.leadingAnchor),
            textField.trailingAnchor.constraint(equalTo: stack.trailingAnchor),
            submitButton.widthAnchor.constraint(equalToConstant: 200),
            submitButton.heightAnchor.constraint(equalToConstant: 44),
        ])

        self.textField = textField
    }

    private var textField: UITextField!

    @objc private func submitTapped() {
        guard let text = textField.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            return
        }
        onScan(text)
    }

    @objc private func cancelTapped() {
        onCancel()
    }
}
#endif

// MARK: - Previews

#if DEBUG
#Preview("QR Scanner") {
    QRScannerView(onScan: { _ in }, onCancel: {})
}
#endif
