export interface DiscordTurnPromptInput {
	authorName: string;
	authorId: string;
	request: string;
	history?: string;
	attachmentNotes: readonly string[];
}

/**
 * Invariant system-layer contract for Discord-created sessions. Its free-variable
 * terminal-report shape is a hypershot: it primes form without task-specific data.
 */
export const DISCORD_WORKER_SYSTEM_SCAFFOLD = `<discord_origin_invariant version="1">
  <bridge_transport_ownership>
    The Discord bridge owns the editable nonterminal status receipt, sanitized activity updates,
    measured elapsed duration, route selection, and the terminal delivery attempt.
    It refreshes the status receipt while an admitted turn is active and replaces it only after the turn ends.
  </bridge_transport_ownership>

  <worker_terminal_duty>
    Do the requested work, then return one self-contained user-facing terminal report as the final assistant response.
    Do not emit or claim bridge status, elapsed duration, route selection, or delivery success.
    State {User_Facing_Outcome_And_Necessary_Next_Action} without internal transport claims.
  </worker_terminal_duty>

  <terminal_report_shape output="Discord Markdown">
    {Direct_Outcome}

    {Concise_Substantive_Result_Or_Reason}

    {Useful_Next_Step_Only_When_Required}
  </terminal_report_shape>
</discord_origin_invariant>`;

const DISCORD_TURN_COMPLETION_CHECKPOINT = `<completion_checkpoint position="immediately_before_end_of_turn">
  Before ending this turn, make the final assistant response a complete user-facing report of the requested work.
  The bridge will attempt to deliver that response in Discord; do not claim that delivery occurred.
</completion_checkpoint>`;

/**
 * Wrap an in-flight Discord steering instruction without reasserting the
 * terminal-turn contract. The existing task owns completion; this envelope
 * supplies only untrusted direction for that task.
 */
export function buildDiscordSteerPrompt(
	input: Pick<DiscordTurnPromptInput, "authorName" | "authorId" | "request">,
): string {
	return `<discord_steer_envelope version="1">
  <bridge_turn_context>
    This is a steering instruction for the currently active Discord task, not a new task.
    Continue using the existing bridge-owned status receipt and terminal-report contract.
  </bridge_turn_context>

  <discord_context trust="untrusted" provenance="Discord">
    <origin author_name="${escapeXml(input.authorName)}" author_id="${escapeXml(input.authorId)}" />
    <steering_instruction>${escapeXml(input.request)}</steering_instruction>
  </discord_context>
</discord_steer_envelope>`;
}

export function buildDiscordTurnPrompt(input: DiscordTurnPromptInput): string {
	const history = input.history
		? `
    <recent_context trust="untrusted">${escapeXml(input.history)}</recent_context>`
		: "";
	const attachmentNotes = input.attachmentNotes
		.map(
			(note) => `
    <attachment_note trust="untrusted">${escapeXml(note)}</attachment_note>`,
		)
		.join("");

	return `<discord_task_envelope version="2">
  <bridge_turn_context>
    The Discord bridge is maintaining the live status receipt for this active turn.
    It, not the worker, owns nonterminal progress and terminal delivery.
  </bridge_turn_context>

  ${DISCORD_TURN_COMPLETION_CHECKPOINT}

  <discord_context trust="untrusted" provenance="Discord">
    <origin author_name="${escapeXml(input.authorName)}" author_id="${escapeXml(input.authorId)}" />
    <request>${escapeXml(input.request)}</request>${history}${attachmentNotes}
  </discord_context>
</discord_task_envelope>`;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}
