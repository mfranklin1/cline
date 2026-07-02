import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { memo, type ReactNode, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { DebouncedTextField } from "../common/DebouncedTextField"
import Section from "../Section"
import { updateSetting } from "../utils/settingsHandlers"

// Reusable checkbox component for feature settings
interface FeatureCheckboxProps {
	checked: boolean | undefined
	onChange: (checked: boolean) => void
	label: string
	description: ReactNode
	disabled?: boolean
	isRemoteLocked?: boolean
	remoteTooltip?: string
	isVisible?: boolean
}

// Interface for feature toggle configuration
interface FeatureToggle {
	id: string
	label: string
	description: ReactNode
	settingKey: keyof UpdateSettingsRequest
	stateKey: string
}

const agentFeatures: FeatureToggle[] = [
	{
		id: "auto-compact",
		label: "Auto Compact",
		description: "Automatically compress conversation history.",
		stateKey: "useAutoCondense",
		settingKey: "useAutoCondense",
	},
]

const editorFeatures: FeatureToggle[] = [
	{
		id: "show-feature-tips",
		label: "Feature Tips",
		description: "Show rotating tips during the thinking phase to help you discover Cline features.",
		stateKey: "showFeatureTips",
		settingKey: "showFeatureTips",
	},
	{
		id: "background-edit",
		label: "Background Edit",
		description: "Allow edits without stealing editor focus",
		stateKey: "backgroundEditEnabled",
		settingKey: "backgroundEditEnabled",
	},
	{
		id: "checkpoints",
		label: "Checkpoints",
		description: "Save progress at key points for easy rollback",
		stateKey: "enableCheckpointsSetting",
		settingKey: "enableCheckpointsSetting",
	},
	{
		id: "worktrees",
		label: "Worktrees",
		description: "Enables git worktree management for running parallel Cline tasks.",
		stateKey: "worktreesEnabled",
		settingKey: "worktreesEnabled",
	},
]

const experimentalFeatures: FeatureToggle[] = [
	{
		id: "yolo",
		label: "Yolo Mode",
		description:
			"Execute tasks without user's confirmation. Auto-switches from Plan to Act mode and disables the ask question tool. Use with extreme caution.",
		stateKey: "yoloModeToggled",
		settingKey: "yoloModeToggled",
	},
]

const advancedFeatures: FeatureToggle[] = [
	{
		id: "hooks",
		label: "Hooks",
		description: "Enable lifecycle and tool hooks during task execution.",
		stateKey: "hooksEnabled",
		settingKey: "hooksEnabled",
	},
]

const FeatureRow = memo(
	({
		checked = false,
		onChange,
		label,
		description,
		disabled,
		isRemoteLocked,
		isVisible = true,
		remoteTooltip,
	}: FeatureCheckboxProps) => {
		if (!isVisible) {
			return null
		}

		const checkbox = (
			<div className="flex items-center justify-between w-full">
				<div>{label}</div>
				<div>
					<Switch
						checked={checked}
						className="shrink-0"
						disabled={disabled || isRemoteLocked}
						id={label}
						onCheckedChange={onChange}
						size="lg"
					/>
					{isRemoteLocked && <i className="codicon codicon-lock text-description text-sm" />}
				</div>
			</div>
		)

		return (
			<div className="flex flex-col items-start justify-between gap-4 py-3 w-full">
				<div className="space-y-0.5 flex-1 w-full">
					{isRemoteLocked ? (
						<Tooltip>
							<TooltipTrigger asChild>{checkbox}</TooltipTrigger>
							<TooltipContent className="max-w-xs" side="top">
								{remoteTooltip}
							</TooltipContent>
						</Tooltip>
					) : (
						checkbox
					)}
				</div>
				<div className="text-xs text-description">{description}</div>
			</div>
		)
	},
)

interface FeatureSettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const FeatureSettingsSection = ({ renderSectionHeader }: FeatureSettingsSectionProps) => {
	const {
		enableCheckpointsSetting,
		hooksEnabled,
		mcpDisplayMode,
		yoloModeToggled,
		useAutoCondense,
		subagentsEnabled,
		worktreesEnabled,
		remoteConfigSettings,
		backgroundEditEnabled,
		showFeatureTips,
		contextJanitorEnabled,
		contextJanitorHeadroomEnabled,
		contextJanitorTriggerTokens,
		contextJanitorGrowthTriggerTokens,
		contextJanitorMaxLatencyMs,
		contextJanitorModelEndpoint,
		contextJanitorModelId,
		claudeEscalationModel,
	} = useExtensionState()

	const isYoloRemoteLocked = remoteConfigSettings?.yoloModeToggled !== undefined

	// State lookup for mapped features
	const featureState: Record<string, boolean | undefined> = {
		showFeatureTips,
		enableCheckpointsSetting,
		hooksEnabled,
		useAutoCondense,
		subagentsEnabled,
		worktreesEnabled: worktreesEnabled?.user,
		backgroundEditEnabled,
		yoloModeToggled: isYoloRemoteLocked ? remoteConfigSettings?.yoloModeToggled : yoloModeToggled,
	}

	// Visibility lookup for features with feature flags
	const featureVisibility: Record<string, boolean | undefined> = {
		worktreesEnabled: worktreesEnabled?.featureFlag,
	}

	return (
		<div className="mb-2">
			{renderSectionHeader("features")}
			<Section>
				<div className="mb-5 flex flex-col gap-3">
					{/* Core features */}
					<div>
						<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">Agent</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50"
							id="agent-features">
							{agentFeatures.map((feature) => (
								<FeatureRow
									checked={featureState[feature.stateKey]}
									description={feature.description}
									isVisible={featureVisibility[feature.stateKey] ?? true}
									key={feature.id}
									label={feature.label}
									onChange={(checked) => updateSetting(feature.settingKey, checked)}
								/>
							))}
						</div>
					</div>

					{/* Context Janitor */}
					<div>
						<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">
							Context Janitor
						</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50"
							id="context-janitor-features">
							<FeatureRow
								checked={contextJanitorEnabled}
								description="Runs a local model before each API call to compress and curate conversation history, reducing token usage."
								label="Context Janitor"
								onChange={(checked) => updateSetting("contextJanitorEnabled", checked)}
							/>
							<FeatureRow
								checked={contextJanitorHeadroomEnabled}
								description="Always-on mechanical compression: deduplicates files and truncates install/test output without a model call."
								label="Headroom Adapter"
								onChange={(checked) => updateSetting("contextJanitorHeadroomEnabled", checked)}
							/>
							{contextJanitorEnabled && (
								<div className="mt-3 space-y-4 border-t border-editor-widget-border/30 pt-3">
									<div className="space-y-1">
										<Label className="text-xs text-foreground/80">Model Endpoint</Label>
										<p className="text-xs text-description mb-1">
											OpenAI-compatible base URL (default: http://127.0.0.1:4000)
										</p>
										<DebouncedTextField
											initialValue={contextJanitorModelEndpoint ?? "http://127.0.0.1:4000"}
											onChange={(val) => updateSetting("contextJanitorModelEndpoint", val)}
											placeholder="http://127.0.0.1:4000"
										/>
									</div>
									<div className="space-y-1">
										<Label className="text-xs text-foreground/80">Model ID</Label>
										<p className="text-xs text-description mb-1">
											Model alias sent to the endpoint (default: local-long)
										</p>
										<DebouncedTextField
											initialValue={contextJanitorModelId ?? "local-long"}
											onChange={(val) => updateSetting("contextJanitorModelId", val)}
											placeholder="local-long"
										/>
									</div>
									<div className="space-y-1">
										<Label className="text-xs text-foreground/80">
											Trigger Threshold (tokens): {contextJanitorTriggerTokens ?? 64000}
										</Label>
										<input
											className="w-full accent-accent"
											max={200000}
											min={8000}
											onChange={(e) => updateSetting("contextJanitorTriggerTokens", Number(e.target.value))}
											step={1000}
											type="range"
											value={contextJanitorTriggerTokens ?? 64000}
										/>
									</div>
									<div className="space-y-1">
										<Label className="text-xs text-foreground/80">
											Growth Trigger (tokens): {contextJanitorGrowthTriggerTokens ?? 20000}
										</Label>
										<input
											className="w-full accent-accent"
											max={100000}
											min={1000}
											onChange={(e) =>
												updateSetting("contextJanitorGrowthTriggerTokens", Number(e.target.value))
											}
											step={1000}
											type="range"
											value={contextJanitorGrowthTriggerTokens ?? 20000}
										/>
									</div>
									<div className="space-y-1">
										<Label className="text-xs text-foreground/80">
											Max Latency (ms): {contextJanitorMaxLatencyMs ?? 45000}
										</Label>
										<input
											className="w-full accent-accent"
											max={120000}
											min={5000}
											onChange={(e) => updateSetting("contextJanitorMaxLatencyMs", Number(e.target.value))}
											step={1000}
											type="range"
											value={contextJanitorMaxLatencyMs ?? 45000}
										/>
									</div>
								</div>
							)}
						</div>
					</div>

					{/* Claude Escalation (MacM4LocalAgent proxy stack) */}
					<div>
						<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">
							Claude Escalation
						</div>
						<div
							className="relative p-3 my-3 rounded-md border border-editor-widget-border/50"
							id="claude-escalation-features">
							<div className="space-y-1">
								<Label className="text-xs text-foreground/80">Escalation Model</Label>
								<p className="text-xs text-description mb-1">
									Claude model used when the local router escalates complex tasks. Haiku rides the Claude
									subscription at no extra cost; Sonnet / Opus / Fable are billed to your Anthropic API key.
								</p>
								<Select
									onValueChange={(v) => updateSetting("claudeEscalationModel", v)}
									value={claudeEscalationModel ?? "haiku"}>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="haiku">Haiku 4.5 — subscription, 200K context</SelectItem>
										<SelectItem value="sonnet">Sonnet 5 — API key, 1M context</SelectItem>
										<SelectItem value="opus">Opus 4.8 — API key, 1M context</SelectItem>
										<SelectItem value="fable">Fable 5 — API key, 1M context</SelectItem>
									</SelectContent>
								</Select>
							</div>
							{claudeEscalationModel && claudeEscalationModel !== "haiku" && (
								<div className="mt-3 space-y-1 border-t border-editor-widget-border/30 pt-3">
									<Label className="text-xs text-foreground/80">Anthropic API Key</Label>
									<p className="text-xs text-description mb-1">
										Saved to the macOS Keychain (item "anthropic-api-key") and read by the local proxy — never
										stored in VS Code. Leave blank to keep the existing key.
									</p>
									<AnthropicKeychainKeyField />
								</div>
							)}
						</div>
					</div>

					{/* Editor features */}
					<div>
						<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">Editor</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50"
							id="optional-features">
							{editorFeatures.map((feature) => (
								<FeatureRow
									checked={featureState[feature.stateKey]}
									description={feature.description}
									isVisible={featureVisibility[feature.stateKey] ?? true}
									key={feature.id}
									label={feature.label}
									onChange={(checked) => updateSetting(feature.settingKey, checked)}
								/>
							))}
						</div>
					</div>

					{/* Experimental features */}
					<div>
						<div className="text-xs font-medium uppercase tracking-wider mb-3 text-warning/80">Experimental</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50 w-full"
							id="experimental-features">
							{experimentalFeatures.map((feature) => (
								<FeatureRow
									checked={featureState[feature.stateKey]}
									description={feature.description}
									disabled={feature.id === "yolo" && isYoloRemoteLocked}
									isRemoteLocked={feature.id === "yolo" && isYoloRemoteLocked}
									isVisible={featureVisibility[feature.stateKey] ?? true}
									key={feature.id}
									label={feature.label}
									onChange={(checked) => updateSetting(feature.settingKey, checked)}
									remoteTooltip="This setting is managed by your organization's remote configuration"
								/>
							))}
						</div>
					</div>
				</div>

				{/* Advanced */}
				<div>
					<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">Advanced</div>
					<div className="relative p-3 my-3 rounded-md border border-editor-widget-border/50" id="advanced-features">
						<div className="space-y-3">
							{advancedFeatures.map((feature) => (
								<FeatureRow
									checked={featureState[feature.stateKey]}
									description={feature.description}
									isVisible={featureVisibility[feature.stateKey] ?? true}
									key={feature.id}
									label={feature.label}
									onChange={(checked) => updateSetting(feature.settingKey, checked)}
								/>
							))}

							{/* MCP Display Mode */}
							<div className="space-y-2">
								<Label className="text-sm font-medium text-foreground">MCP Display Mode</Label>
								<p className="text-xs text-muted-foreground">Controls how MCP responses are displayed</p>
								<Select onValueChange={(v) => updateSetting("mcpDisplayMode", v)} value={mcpDisplayMode}>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="plain">Plain Text</SelectItem>
										<SelectItem value="rich">Rich Display</SelectItem>
										<SelectItem value="markdown">Markdown</SelectItem>
									</SelectContent>
								</Select>
							</div>
						</div>
					</div>
				</div>
			</Section>
		</div>
	)
}
/**
 * Password-style input + explicit save button for the Anthropic API key.
 * The value is sent once via the transient anthropicEscalationApiKey
 * UpdateSettings field (written to the macOS Keychain host-side) and the
 * local input is cleared -- the key is never kept in webview state.
 */
const AnthropicKeychainKeyField = () => {
	const [pendingKey, setPendingKey] = useState("")
	const [saved, setSaved] = useState(false)
	const looksValid = pendingKey.trim().startsWith("sk-ant-") && pendingKey.trim().length >= 40
	const save = () => {
		if (!looksValid) {
			return
		}
		updateSetting("anthropicEscalationApiKey", pendingKey.trim())
		setPendingKey("")
		setSaved(true)
		setTimeout(() => setSaved(false), 3000)
	}
	return (
		<div className="flex gap-2 items-center">
			<Input
				className="flex-1"
				onChange={(e) => setPendingKey(e.target.value)}
				placeholder="sk-ant-..."
				type="password"
				value={pendingKey}
			/>
			<Button disabled={!looksValid} onClick={save} size="sm" variant="secondary">
				{saved ? "Saved ✓" : "Save to Keychain"}
			</Button>
		</div>
	)
}

export default memo(FeatureSettingsSection)
