import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ThinkingRow } from "./ThinkingRow"

describe("ThinkingRow", () => {
	it("renders streaming title styling and expanded reasoning content", () => {
		render(
			<ThinkingRow
				isExpanded={true}
				isStreaming={true}
				isVisible={true}
				reasoningContent="Inspecting files..."
				showTitle={true}
				title="Thinking..."
			/>,
		)

		const title = screen.getByText("Thinking...")
		expect(title).toBeInTheDocument()
		expect(title).toHaveClass("animate-shimmer")
		expect(screen.getByText("Inspecting files...")).toBeInTheDocument()
	})

	it("shows a spinner while streaming (request pending / reasoning)", () => {
		const { container } = render(
			<ThinkingRow isExpanded={false} isStreaming={true} isVisible={true} showTitle={true} title="Analysing request..." />,
		)
		expect(screen.getByText("Analysing request...")).toBeInTheDocument()
		expect(container.querySelector(".animate-spin")).toBeInTheDocument()
	})

	it("hides the spinner when not streaming", () => {
		const { container } = render(
			<ThinkingRow isExpanded={false} isStreaming={false} isVisible={true} showTitle={true} title="Thinking" />,
		)
		expect(container.querySelector(".animate-spin")).not.toBeInTheDocument()
	})

	it("calls onToggle when header is clicked", () => {
		const onToggle = vi.fn()

		render(
			<ThinkingRow
				isExpanded={false}
				isVisible={true}
				onToggle={onToggle}
				reasoningContent="some reasoning"
				showTitle={true}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Thinking/i }))
		expect(onToggle).toHaveBeenCalledTimes(1)
	})
})
