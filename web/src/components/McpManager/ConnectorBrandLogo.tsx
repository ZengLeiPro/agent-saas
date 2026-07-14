import { EntityIcons } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { McpServerSummary } from "@agent/shared";
import githubIcon from "@/assets/connector-brands/github.svg";
import gmailIcon from "@/assets/connector-brands/gmail.png";
import googleCalendarIcon from "@/assets/connector-brands/google-calendar.png";
import googleChatIcon from "@/assets/connector-brands/google-chat.png";
import googleContactsIcon from "@/assets/connector-brands/google-contacts.png";
import googleDriveIcon from "@/assets/connector-brands/google-drive.png";
import notionIcon from "@/assets/connector-brands/notion.svg";

const BRAND_ICON_BY_TEMPLATE_ID: Record<string, string> = {
  github: githubIcon,
  notion: notionIcon,
  google_gmail: gmailIcon,
  google_drive: googleDriveIcon,
  google_calendar: googleCalendarIcon,
  google_chat: googleChatIcon,
  google_people: googleContactsIcon,
};

export function connectorBrandIcon(server: McpServerSummary): string | null {
  const templateId = server.createdFromTemplateId?.toLocaleLowerCase();
  if (templateId && BRAND_ICON_BY_TEMPLATE_ID[templateId]) return BRAND_ICON_BY_TEMPLATE_ID[templateId];

  const configUrl = typeof server.config?.url === "string" ? server.config.url : "";
  const identity = `${server.id} ${server.name} ${configUrl}`.toLocaleLowerCase();
  if (identity.includes("github")) return githubIcon;
  if (identity.includes("notion")) return notionIcon;
  if (identity.includes("gmail")) return gmailIcon;
  if (identity.includes("drive.google") || identity.includes("google drive")) return googleDriveIcon;
  if (identity.includes("calendar.google") || identity.includes("google calendar")) return googleCalendarIcon;
  if (identity.includes("chat.google") || identity.includes("google chat")) return googleChatIcon;
  if (identity.includes("people.google") || identity.includes("google contacts")) return googleContactsIcon;
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
        <img src={brandIcon} alt="" className="size-7 object-contain" />
      ) : (
        <EntityIcons.connector className="size-5 text-brand-700" />
      )}
    </span>
  );
}
