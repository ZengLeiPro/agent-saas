import { EntityIcons } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { McpServerSummary } from "@agent/shared";

const BRAND_ICON_BY_TEMPLATE_ID: Record<string, string> = {
  github: "github.svg",
  notion: "notion.svg",
  google_gmail: "gmail.png",
  google_drive: "google-drive.png",
  google_calendar: "google-calendar.png",
  google_chat: "google-chat.png",
  google_people: "google-contacts.png",
};

export function connectorBrandIcon(server: McpServerSummary): string | null {
  const templateId = server.createdFromTemplateId?.toLocaleLowerCase();
  if (templateId && BRAND_ICON_BY_TEMPLATE_ID[templateId]) return BRAND_ICON_BY_TEMPLATE_ID[templateId];

  const configUrl = typeof server.config?.url === "string" ? server.config.url : "";
  const identity = `${server.id} ${server.name} ${configUrl}`.toLocaleLowerCase();
  if (identity.includes("github")) return "github.svg";
  if (identity.includes("notion")) return "notion.svg";
  if (identity.includes("gmail")) return "gmail.png";
  if (identity.includes("drive.google") || identity.includes("google drive")) return "google-drive.png";
  if (identity.includes("calendar.google") || identity.includes("google calendar")) return "google-calendar.png";
  if (identity.includes("chat.google") || identity.includes("google chat")) return "google-chat.png";
  if (identity.includes("people.google") || identity.includes("google contacts")) return "google-contacts.png";
  return null;
}

export function ConnectorBrandLogo({ server, className }: { server: McpServerSummary; className?: string }) {
  const brandIcon = connectorBrandIcon(server);
  return (
    <span
      className={cn(
        "flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-inset ring-black/10 dark:bg-white",
        className,
      )}
      aria-hidden="true"
    >
      {brandIcon ? (
        <img src={`/connector-brands/${brandIcon}`} alt="" className="size-7 object-contain" />
      ) : (
        <EntityIcons.connector className="size-5 text-brand-700" />
      )}
    </span>
  );
}
