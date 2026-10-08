import { errorToast } from "@/lib/errorToast";

export function savePreference(operation: Promise<void>): void {
  void operation.catch((error) => errorToast("Could not save setting", error));
}
