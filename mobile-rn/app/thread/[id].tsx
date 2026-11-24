import { useLocalSearchParams, useRouter } from "expo-router";
import ConversationScreen from "../../src/screens/ConversationScreen";

/**
 * KIN-MOBILE-001 R4b — the conversation route.
 *
 * One dynamic segment carries the task id. It is narrowed to one string here
 * so the screen never receives an array, and Back pops the stack to the list,
 * which stayed mounted with its folds and scroll position.
 */
export default function ThreadRoute() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const taskId = Array.isArray(id) ? (id[0] ?? "") : (id ?? "");

  return <ConversationScreen onBack={() => router.back()} taskId={taskId} />;
}
