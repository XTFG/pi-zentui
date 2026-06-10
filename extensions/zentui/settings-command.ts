import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	type ColorSource,
	type ColorSourcesConfig,
	type ExtensionStatusPlacement,
	type PolishedTuiConfig,
	type UiFeaturesConfig,
	getExtensionStatusPlacement,
	isExtensionStatusPlacement,
} from "./config";
import { sanitizeExtensionStatusText } from "./extension-status";
import { EDITOR_BORDER_STYLE, renderChromeBorder, safeThemeFg } from "./style";

const colorSourceValues: ColorSource[] = ["theme", "terminal"];
const extensionStatusPlacementValues: ExtensionStatusPlacement[] = [
	"off",
	"left",
	"middle",
	"right",
];
type FeatureState = "enabled" | "disabled";

const featureStateValues: FeatureState[] = ["enabled", "disabled"];
const settingsSections = ["coloring", "features", "statusLine"] as const;

type ColorSettingId = "starship" | "editorMessages";
type FeatureSettingId = keyof UiFeaturesConfig;
type SettingsSection = (typeof settingsSections)[number];

type SettingsCommandDeps = {
	getConfig: () => PolishedTuiConfig;
	setColorSources: (patch: Partial<ColorSourcesConfig>) => void;
	setUiFeatures: (
		patch: Partial<UiFeaturesConfig>,
		ctx: ExtensionContext,
	) => { applied: boolean; reason?: string };
	getActiveExtensionStatuses: () => ReadonlyMap<string, string>;
	setExtensionStatusPlacement: (key: string, placement: ExtensionStatusPlacement) => void;
	requestRender: () => void;
	settingsListTheme?: SettingsListTheme;
};

const colorSettingLabels: Record<ColorSettingId, string> = {
	starship: "Starship/footer colors",
	editorMessages: "Editor + previous messages",
};

const colorSettingDescriptions: Record<ColorSettingId, string> = {
	starship:
		"Choose whether footer runtime/git/context colors use Pi theme tokens or terminal palette styles.",
	editorMessages:
		"Choose whether editor and previous user-message borders/rails use Pi theme colors or terminal palette styles.",
};

const featureSettingLabels: Record<FeatureSettingId, string> = {
	editor: "Editor",
	statusLine: "Status line",
	copyFriendly: "Copy-friendly mode",
};

const featureSettingDescriptions: Record<FeatureSettingId, string> = {
	editor:
		"Enable or disable Zentui's custom editor, selector borders, and previous-message chrome.",
	statusLine: "Enable or disable Zentui's custom footer/status line.",
	copyFriendly:
		"Hide editor and previous-message rail glyphs for cleaner native terminal selection.",
};

const directCommandSuggestions = [
	"editor enable",
	"editor disable",
	"editor toggle",
	"statusline enable",
	"statusline disable",
	"statusline toggle",
	"copy-friendly enable",
	"copy-friendly disable",
	"copy-friendly toggle",
];

const sectionLabels: Record<SettingsSection, string> = {
	coloring: "Coloring",
	features: "Features",
	statusLine: "Status line",
};

const thirdPartyStatusSettingPrefix = "thirdPartyStatus:";

function isColorSource(value: string): value is ColorSource {
	return value === "theme" || value === "terminal";
}

function isColorSettingId(value: string): value is ColorSettingId {
	return value === "starship" || value === "editorMessages";
}

function isFeatureSettingId(value: string): value is FeatureSettingId {
	return value === "editor" || value === "statusLine" || value === "copyFriendly";
}

function isFeatureState(value: string): value is FeatureState {
	return value === "enabled" || value === "disabled";
}

function editorMessageValue(config: PolishedTuiConfig): ColorSource | "mixed" {
	return config.colorSources.editor === config.colorSources.userMessages
		? config.colorSources.editor
		: "mixed";
}

function patchForSetting(id: ColorSettingId, value: ColorSource): Partial<ColorSourcesConfig> {
	return id === "starship" ? { starship: value } : { editor: value, userMessages: value };
}

function featureValue(enabled: boolean): FeatureState {
	return enabled ? "enabled" : "disabled";
}

function featurePatch(id: FeatureSettingId, value: FeatureState): Partial<UiFeaturesConfig> {
	return { [id]: value === "enabled" } as Partial<UiFeaturesConfig>;
}

function usageText(): string {
	return "Usage: /zentui [editor|statusline|copy-friendly] [enable|disable|toggle]";
}

function featureNotification(
	feature: FeatureSettingId,
	value: FeatureState,
	result: { applied: boolean; reason?: string },
): string {
	const base = `${featureSettingLabels[feature]}: ${value}`;
	return result.applied ? base : `${base} (${result.reason ?? "reload Pi to apply this change"})`;
}

function parseDirectFeatureCommand(
	args: string,
	config: PolishedTuiConfig,
): { feature: FeatureSettingId; enabled: boolean } | undefined {
	const normalized = args.trim().toLowerCase().replaceAll(/[_-]+/g, " ");
	if (!normalized) return undefined;

	const words = normalized.split(/\s+/g).filter(Boolean);
	const hasWord = (value: string) => words.includes(value);
	const feature = hasWord("editor")
		? "editor"
		: hasWord("footer") || hasWord("statusline") || hasWord("status")
			? "statusLine"
			: hasWord("copyfriendly") || hasWord("copy")
				? "copyFriendly"
				: undefined;
	const action = hasWord("toggle")
		? "toggle"
		: hasWord("enable") || hasWord("enabled") || hasWord("on")
			? "enable"
			: hasWord("disable") || hasWord("disabled") || hasWord("off")
				? "disable"
				: undefined;

	if (!feature || !action) return undefined;

	return {
		feature,
		enabled: action === "toggle" ? !config.features[feature] : action === "enable",
	};
}

function argumentCompletions(prefix: string): AutocompleteItem[] | null {
	const trimmedPrefix = prefix.trimStart().toLowerCase();
	const items = directCommandSuggestions.map((value) => ({ value, label: value }));
	const matches = items.filter((item) => item.value.startsWith(trimmedPrefix));
	return matches.length > 0 ? matches : null;
}

function buildItems(
	section: SettingsSection,
	config: PolishedTuiConfig,
	activeStatuses: ReadonlyMap<string, string>,
): SettingItem[] {
	if (section === "coloring") {
		return (Object.keys(colorSettingLabels) as ColorSettingId[]).map((key) => ({
			id: key,
			label: colorSettingLabels[key],
			description: colorSettingDescriptions[key],
			currentValue: key === "starship" ? config.colorSources.starship : editorMessageValue(config),
			values: colorSourceValues,
		}));
	}

	if (section === "features") {
		return (Object.keys(featureSettingLabels) as FeatureSettingId[]).map((key) => ({
			id: key,
			label: featureSettingLabels[key],
			description: featureSettingDescriptions[key],
			currentValue: featureValue(config.features[key]),
			values: featureStateValues,
		}));
	}

	const statuses = Array.from(activeStatuses.entries()).sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
	if (statuses.length === 0) {
		return [
			{
				id: "noThirdPartyStatuses",
				label: "No active statuses",
				description:
					"This section only lists statuses currently published through ctx.ui.setStatus().",
				currentValue: "—",
			},
		];
	}

	return statuses.map(([key, value]) => {
		const sanitizedText = sanitizeExtensionStatusText(value);
		return {
			id: `${thirdPartyStatusSettingPrefix}${key}`,
			label: key,
			description: sanitizedText ? `Current status: ${sanitizedText}` : undefined,
			currentValue: getExtensionStatusPlacement(config, key),
			values: extensionStatusPlacementValues,
		};
	});
}

function thirdPartyStatusKeyFromSettingId(id: string): string | undefined {
	return id.startsWith(thirdPartyStatusSettingPrefix)
		? id.slice(thirdPartyStatusSettingPrefix.length)
		: undefined;
}

function nextSection(section: SettingsSection): SettingsSection {
	const currentIndex = settingsSections.indexOf(section);
	return settingsSections[(currentIndex + 1) % settingsSections.length] ?? "coloring";
}

function formatSectionTabs(
	activeSection: SettingsSection,
	theme: ExtensionContext["ui"]["theme"],
): string {
	const rendered = settingsSections.map((section) => {
		const label = sectionLabels[section];
		return section === activeSection ? theme.bold(label) : safeThemeFg(theme, "muted", label);
	});
	return `  ${rendered.join(safeThemeFg(theme, "muted", " / "))}`;
}

function withSectionFooter(lines: string[], theme: ExtensionContext["ui"]["theme"]): string[] {
	const next = [...lines];
	for (let index = next.length - 1; index >= 0; index -= 1) {
		if (next[index]?.includes("Enter/Space")) {
			next[index] = safeThemeFg(
				theme,
				"muted",
				"  Enter/Space to change · Tab to switch sections · Esc to close",
			);
			break;
		}
	}
	return next;
}

export function registerZentuiSettingsCommand(pi: ExtensionAPI, deps: SettingsCommandDeps): void {
	pi.registerCommand("zentui", {
		description: "Configure Zentui",
		getArgumentCompletions: argumentCompletions,
		handler: async (_args, ctx) => {
			const args = typeof _args === "string" ? _args : "";
			const directCommand = parseDirectFeatureCommand(args, deps.getConfig());
			if (directCommand) {
				try {
					const result = deps.setUiFeatures(
						{ [directCommand.feature]: directCommand.enabled },
						ctx,
					);
					deps.requestRender();
					if (ctx.hasUI) {
						ctx.ui.notify(
							featureNotification(
								directCommand.feature,
								featureValue(directCommand.enabled),
								result,
							),
							"info",
						);
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (ctx.hasUI) ctx.ui.notify(`Could not update Zentui settings: ${message}`, "error");
				}
				return;
			}

			if (args.trim()) {
				if (ctx.hasUI) ctx.ui.notify(usageText(), "warning");
				return;
			}

			if (!ctx.hasUI) return;

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const settingsListTheme = deps.settingsListTheme ?? getSettingsListTheme();
				let activeSection: SettingsSection = "coloring";
				const applyFeatureChange = (id: FeatureSettingId, newValue: FeatureState) => {
					const result = deps.setUiFeatures(featurePatch(id, newValue), ctx);
					deps.requestRender();
					ctx.ui.notify(featureNotification(id, newValue, result), "info");
					tui.requestRender();
				};
				let settingsList: SettingsList;
				const makeSettingsList = () =>
					new SettingsList(
						buildItems(activeSection, deps.getConfig(), deps.getActiveExtensionStatuses()),
						8,
						settingsListTheme,
						(id, newValue) => {
							try {
								if (isColorSettingId(id) && isColorSource(newValue)) {
									deps.setColorSources(patchForSetting(id, newValue));
									settingsList.updateValue(id, newValue);
									deps.requestRender();
									ctx.ui.notify(`${colorSettingLabels[id]}: ${newValue}`, "info");
									tui.requestRender();
									return;
								}

								if (isFeatureSettingId(id) && isFeatureState(newValue)) {
									settingsList.updateValue(id, newValue);
									if (id === "editor") {
										done(undefined);
										// Changing the editor component while ctx.ui.custom() is active clears the
										// custom component without resolving it, leaving Pi's input loop stuck.
										// Close the settings UI first, then apply the editor swap on the next tick.
										setTimeout(() => {
											try {
												applyFeatureChange(id, newValue);
											} catch (error) {
												const message = error instanceof Error ? error.message : String(error);
												ctx.ui.notify(`Could not update Zentui settings: ${message}`, "error");
											}
										}, 0);
										return;
									}

									applyFeatureChange(id, newValue);
									return;
								}

								const thirdPartyStatusKey = thirdPartyStatusKeyFromSettingId(id);
								if (thirdPartyStatusKey && isExtensionStatusPlacement(newValue)) {
									deps.setExtensionStatusPlacement(thirdPartyStatusKey, newValue);
									settingsList.updateValue(id, newValue);
									deps.requestRender();
									ctx.ui.notify(`Third-party status ${thirdPartyStatusKey}: ${newValue}`, "info");
									tui.requestRender();
								}
							} catch (error) {
								const message = error instanceof Error ? error.message : String(error);
								ctx.ui.notify(`Could not update Zentui settings: ${message}`, "error");
							}
						},
						() => done(undefined),
					);
				settingsList = makeSettingsList();
				const switchSection = () => {
					activeSection = nextSection(activeSection);
					settingsList = makeSettingsList();
					tui.requestRender();
				};

				return {
					render(width: number) {
						const colorSource = deps.getConfig().colorSources.editor;
						const border = renderChromeBorder(
							theme,
							colorSource,
							EDITOR_BORDER_STYLE,
							"─".repeat(Math.max(0, width)),
						);
						return [
							truncateToWidth(border, width, ""),
							truncateToWidth(formatSectionTabs(activeSection, theme), width, ""),
							truncateToWidth(border, width, ""),
							...withSectionFooter(settingsList.render(width), theme).map((line) =>
								truncateToWidth(line, width, ""),
							),
							truncateToWidth(border, width, ""),
						];
					},
					invalidate() {
						settingsList.invalidate();
					},
					handleInput(data: string) {
						if (data === "\t") {
							switchSection();
							return;
						}
						settingsList.handleInput(data);
					},
				};
			});
		},
	});
}
