import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var appModel

    var body: some View {
        @Bindable var model = appModel

        return TabView(selection: $model.selectedTab) {
            ControlView()
                .tabItem {
                    Label(
                        String(localized: "Control", comment: "Tab bar label for the control view"),
                        systemImage: "terminal"
                    )
                }
                .tag(AppModel.Tab.control)

            TaskListView()
                .tabItem {
                    Label(
                        String(localized: "Tasks", comment: "Tab bar label for the tasks list"),
                        systemImage: "list.bullet"
                    )
                }
                .tag(AppModel.Tab.tasks)

            SettingsView()
                .tabItem {
                    Label(
                        String(localized: "Settings", comment: "Tab bar label for settings"),
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