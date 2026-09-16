import SwiftUI

struct ForkTaskView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppSession.self) private var appSession
    let taskId: String
    let onCreated: (KinTask) -> Void

    @State private var prompt = ""
    @State private var isSubmitting = false
    @State private var error: String?
    @State private var viewModel = TaskDetailViewModel()

    var body: some View {
        NavigationStack {
            Form {
                Section("New task direction") {
                    TextEditor(text: $prompt)
                        .frame(minHeight: 150)
                }
                if let error {
                    Text(error).foregroundStyle(.red)
                }
                Button {
                    Task { await submit() }
                } label: {
                    HStack {
                        Spacer()
                        if isSubmitting { ProgressView() } else { Text("Fork Task") }
                        Spacer()
                    }
                }
                .disabled(isSubmitting)
            }
            .navigationTitle("Fork Task")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func submit() async {
        guard let client = appSession.apiClient else { return }
        isSubmitting = true
        defer { isSubmitting = false }
        let task = await viewModel.fork(
            taskId: taskId,
            prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : prompt,
            with: client
        )
        if let task {
            onCreated(task)
            dismiss()
        } else {
            error = viewModel.error
        }
    }
}
