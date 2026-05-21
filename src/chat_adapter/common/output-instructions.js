export const ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS = [
  "To send local files through the relay, insert this XML control block anywhere in the reply when needed. Multiple blocks are allowed and will be processed in order:",
  "<attachments>",
  '<attachment path="./artifacts/chart.png" kind="photo" />',
  '<attachment path="./artifacts/report.pdf" kind="document" />',
  "</attachments>",
  "Use valid XML only. Each attachment needs path. kind is optional and defaults to photo for common image files, otherwise document. Relative paths resolve against the current workdir."
].join("\n");
