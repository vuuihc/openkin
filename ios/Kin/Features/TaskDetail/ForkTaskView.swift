import SwiftUI

struct ForkTaskView: View {
    @Environment(\.dismiss) private var dismiss
    let taskId: String
    let apiClient: APIClient
    let onCreated: (KinTask) -> Void

    @State private var prompt = ""
    @State private var isSubmitting = false
    @State private var error: String?
    @State private var viewModel = TaskDetailViewModel()

    var body: some View {
        NavigationStack {
            Form {
                Section(String(localized: "task.fork.direction")) {
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
                        if isSubmitting {
                            ProgressView()
                        } else {
                            Text(String(localized: "task.action.fork_task"))
                        }
                        Spacer()
                    }
                }
                .disabled(isSubmitting)
            }
            .navigationTitle(String(localized: "task.action.fork_task"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "task.cancel")) { dismiss() }
                }
            }
        }
    }

    private func submit() async {
        isSubmitting = true
        defer { isSubmitting = false }
        let task = await viewModel.fork(
            taskId: taskId,
            prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : prompt,
            with: apiClient
        )
        if let task {
            onCreated(task)
            dismiss()
        } else {
            error = viewModel.error
        }
    }
}
