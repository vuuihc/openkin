import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var appModel

    var body: some View {
        @Bindable var model = appModel

        return TabView(selection: $model.selectedTab) {
            ControlView()
                .tabItem {
                    Label(
                        String(localized: String.LocalizationValue(AppModel.Tab.control.localizationKey)),
                        systemImage: "sparkle.magnifyingglass"
                    )
                }
                .tag(AppModel.Tab.control)

            TaskListView()
                .tabItem {
                    Label(
                        String(localized: String.LocalizationValue(AppModel.Tab.tasks.localizationKey)),
                        systemImage: "list.bullet"
                    )
                }
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
}

#Preview {
    ContentView()
        .environment(AppModel())
}
