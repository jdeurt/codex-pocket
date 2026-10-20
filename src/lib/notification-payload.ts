/**
The completion message serialized by the server and consumed by the classic worker.
*/
export interface NotificationPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
}
