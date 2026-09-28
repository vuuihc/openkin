import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var appModel
    @Environment(AppSession.self) private var appSession

    var body: some View {
        @Bindable var model = appModel

        return TabView(selection: $model.selectedTab) {
            TaskListView()
                .tabItem {
                    Label(
                        String(localized: String.LocalizationValue(AppModel.Tab.tasks.localizationKey)),
                        systemImage: "bubble.left.and.bubble.right"
                    )
                }
                // Approvals and questions have no tab of their own; this is how a
                // conversation that is waiting on you announces itself from
                // outside the list.
                .badge(pendingActionCount)
                .tag(AppModel.Tab.tasks)

            ProjectsView()
                .tabItem {
                    Label(
                        String(localized: String.LocalizationValue(AppModel.Tab.projects.localizationKey)),
                        systemImage: "folder"
                    )
                }
                .tag(AppModel.Tab.projects)

            ArtifactsView()
                .tabItem {
                    Label(
                        String(localized: String.LocalizationValue(AppModel.Tab.artifacts.localizationKey)),
                        systemImage: "doc.text"
                    )
                }
                .tag(AppModel.Tab.artifacts)

            SettingsView()
                .tabItem {
                    Label(
                        String(localized: String.LocalizationValue(AppModel.Tab.settings.localizationKey)),
                        systemImage: "gear"
                    )
                }
                .tag(AppModel.Tab.settings)
        }
        .overlay(alignment: .top) {
            ConnectionBanner()
        }
        .environment(appModel)
    }

    private var pendingActionCount: Int {
        appSession.approvals.count + appSession.questions.count
    }
}

#Preview {
    ContentView()
        .environment(AppModel())
        .environment(AppSession())
}
