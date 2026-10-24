import { type NotificationController } from "../services/notifications";

/** Start native permission work in the user gesture; the controller publishes failures.
@param notifications - Mounted device-notification owner.
*/
export function requestNotifications(notifications: NotificationController) {
  void notifications.enable();
}
