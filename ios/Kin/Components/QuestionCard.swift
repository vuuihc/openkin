import SwiftUI

/// A card that displays a question from the agent and collects user input.
///
/// Supports single-select (radio buttons), multi-select (checkmarks), and
/// free-text question types.
struct QuestionCard: View {
    let question: UserQuestion
    let onAnswer: (
        _ questionId: String,
        _ selectedOptionIds: [String]?,
        _ freeText: String?
    ) async throws -> Void

    @State private var selectedIds: Set<String> = []
    @State private var freeText: String = ""
    @State private var isInFlight = false
    @State private var answerError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack(spacing: 6) {
                Image(systemName: "questionmark.bubble")
                    .foregroundStyle(.blue)
                    .font(.caption)

                Text(
                    String(localized: "Question", comment: "Question card title")
                )
                .font(.subheadline)
                .fontWeight(.semibold)

                Spacer()

                if isInFlight {
                    ProgressView()
                        .scaleEffect(0.7)
                }
            }

            // Question text
            Text(question.question)
                .font(.body)

            // Input area based on type
            switch question.type {
            case .singleSelect:
                singleSelectView
            case .multiSelect:
                multiSelectView
            case .freeText:
                freeTextView
            case .unknown:
                unknownTypeView
            }

            // Error
            if let error = answerError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            // Answer button
            Button {
                submitAnswer()
            } label: {
                Text(
                    String(localized: "Answer", comment: "Question card: answer button")
                )
                .fontWeight(.medium)
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(isInFlight || !canSubmit)
        }
        .padding(14)
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.06), radius: 4, x: 0, y: 2)
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color(.separator).opacity(0.3), lineWidth: 0.5)
        )
        .onAppear {
            // Pre-select any already-selected options
            if let options = question.options {
                selectedIds = Set(options.compactMap { $0.selected == true ? $0.id : nil })
            }
        }
    }

    // MARK: - Question type views

    @ViewBuilder
    private var singleSelectView: some View {
        if let options = question.options, !options.isEmpty {
            VStack(spacing: 6) {
                ForEach(options) { option in
                    Button {
                        selectedIds = [option.id]
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: selectedIds.contains(option.id)
                                ? "circle.fill"
                                : "circle")
                                .foregroundStyle(selectedIds.contains(option.id)
                                    ? Color.accentColor
                                    : .secondary)
                                .font(.caption)

                            Text(option.label)
                                .font(.subheadline)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.vertical, 6)
                        .padding(.horizontal, 8)
                        .background(
                            RoundedRectangle(cornerRadius: 6)
                                .fill(selectedIds.contains(option.id)
                                    ? Color.accentColor.opacity(0.08)
                                    : Color(.systemGray6))
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder
    private var multiSelectView: some View {
        if let options = question.options, !options.isEmpty {
            VStack(spacing: 6) {
                ForEach(options) { option in
                    Button {
                        if selectedIds.contains(option.id) {
                            selectedIds.remove(option.id)
                        } else {
                            selectedIds.insert(option.id)
                        }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: selectedIds.contains(option.id)
                                ? "checkmark.square.fill"
                                : "square")
                                .foregroundStyle(selectedIds.contains(option.id)
                                    ? Color.accentColor
                                    : .secondary)
                                .font(.caption)

                            Text(option.label)
                                .font(.subheadline)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.vertical, 6)
                        .padding(.horizontal, 8)
                        .background(
                            RoundedRectangle(cornerRadius: 6)
                                .fill(selectedIds.contains(option.id)
                                    ? Color.accentColor.opacity(0.08)
                                    : Color(.systemGray6))
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder
    private var freeTextView: some View {
        TextField(
            String(localized: "Type your answer…", comment: "Question card: free-text placeholder"),
            text: $freeText,
            axis: .vertical
        )
        .textFieldStyle(.roundedBorder)
        .lineLimit(3...6)
    }

    @ViewBuilder
    private var unknownTypeView: some View {
        Text(
            String(localized: "This question type is not supported.", comment: "Question card: unknown type message")
        )
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    // MARK: - Helpers

    private var canSubmit: Bool {
        switch question.type {
        case .singleSelect:
            !selectedIds.isEmpty
        case .multiSelect:
            !selectedIds.isEmpty
        case .freeText:
            !freeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .unknown:
            false
        }
    }

    private func submitAnswer() {
        isInFlight = true
        answerError = nil

        Task {
            do {
                switch question.type {
                case .singleSelect, .multiSelect:
                    try await onAnswer(question.id, Array(selectedIds), nil)
                case .freeText:
                    try await onAnswer(question.id, nil, freeText)
                case .unknown:
                    break
                }
            } catch {
                answerError = error.localizedDescription
            }
            isInFlight = false
        }
    }
}

// MARK: - Preview

#Preview("Single select") {
    QuestionCard(
        question: UserQuestion(
            id: "q-1",
            taskId: "task-1",
            question: "Which programming language should we use for this project?",
            type: .singleSelect,
            options: [
                QuestionOption(id: "1", label: "Swift", selected: nil),
                QuestionOption(id: "2", label: "Kotlin", selected: nil),
                QuestionOption(id: "3", label: "Rust", selected: nil),
            ],
            otherText: nil,
            answeredAt: nil
        ),
        onAnswer: { _, _, _ in }
    )
    .padding()
}

#Preview("Multi select") {
    QuestionCard(
        question: UserQuestion(
            id: "q-2",
            taskId: "task-1",
            question: "Which features should be included in the MVP?",
            type: .multiSelect,
            options: [
                QuestionOption(id: "1", label: "User authentication", selected: nil),
                QuestionOption(id: "2", label: "Dashboard", selected: nil),
                QuestionOption(id: "3", label: "Notifications", selected: nil),
                QuestionOption(id: "4", label: "Export", selected: nil),
            ],
            otherText: nil,
            answeredAt: nil
        ),
        onAnswer: { _, _, _ in }
    )
    .padding()
}

#Preview("Free text") {
    QuestionCard(
        question: UserQuestion(
            id: "q-3",
            taskId: "task-1",
            question: "Describe the architecture you have in mind:",
            type: .freeText,
            options: nil,
            otherText: nil,
            answeredAt: nil
        ),
        onAnswer: { _, _, _ in }
    )
    .padding()
}