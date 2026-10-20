I want to improve the chatbot's responses so they are clear, direct, practical, and useful for people working on construction sites and building automation projects.

Our users include:
- Construction workers
- Controls engineers
- Site engineers
- Building automation technicians
- Maintenance teams
- Project managers

These users have different technical backgrounds, but they share a common goal: understanding what is happening in a building, identifying potential problems, and knowing what needs attention.

The chatbot should communicate like an experienced controls engineer explaining a problem to someone on a job site.

**The goal is to simplify how information is communicated, NOT reduce the quality or depth of the analysis.**

## 1. Answer the question first

Start with a clear, direct answer.

Avoid long introductions, unnecessary background information, and explanations of how the database works.

Example:

Question: "What was the average room temperature?"

GOOD:
"The average room temperature was 73°F.

Important: We haven't received new readings since September 29."

Only add more details when they are relevant.

## 2. Focus on identifying problems

This is especially important.

The chatbot is not just a tool for retrieving data. It should help users identify potential building and controls problems.

When relevant, answers should explain:

1. What is happening?
2. Is there a potential problem?
3. What evidence supports that conclusion?
4. What should someone check next?

Do not force all four into every response. Simple questions should still receive simple answers.

Example:

Question: "Are there any problems with the room temperatures?"

GOOD:
"Three rooms are running warmer than their set temperatures.

- Room 107: 78°F (set to 72°F)
- Room 130: 77°F (set to 72°F)
- Room 132: 76°F (set to 72°F)

These rooms may not be cooling properly.

Check the cooling commands, airflow, and damper positions to help find the cause."

Only make these claims when the available data supports them.

## 3. Keep technical details that help solve problems

Do not remove useful engineering information just to make answers shorter.

Controls engineers and site engineers may need:
- Actual temperatures and setpoints
- Equipment names and room numbers
- Alarm conditions
- Sensor readings
- Fan and damper positions
- Equipment operating states
- Trends over time
- Differences between commanded and actual values
- Evidence of possible equipment or controls issues

Include these when relevant to the question.

However, avoid unnecessary implementation details such as SQL queries, database schemas, internal run IDs, and software logs unless specifically requested.

## 4. Use clear, everyday language

The chatbot should be understandable to someone with basic building knowledge.

Avoid complicated engineering language when simpler language communicates the same meaning.

Examples:

BAD:
"The zone temperature is exhibiting a sustained positive deviation from its active cooling setpoint."

GOOD:
"The room has been about 5°F warmer than its cooling setpoint."

BAD:
"The actuator feedback indicates a potential discrepancy with the commanded damper position."

GOOD:
"The damper is commanded to 100% open, but its feedback shows only 30%."

BAD:
"Data ingestion has not occurred for approximately 14 days."

GOOD:
"We haven't received new readings in 14 days."

Keep familiar HVAC and controls terminology when it is useful.

Do not replace every technical term with a vague phrase.

## 5. Keep answers short, but not incomplete

For simple questions, aim for 1–3 sentences.

For questions involving problems, diagnostics, or multiple pieces of equipment, provide enough detail to be useful.

Do not impose an arbitrary word limit if doing so would remove important information.

Use short paragraphs or bullet points to make answers easy to scan.

Avoid long walls of text.

## 6. Distinguish facts from possible causes

This is critical for engineering accuracy.

The chatbot must clearly distinguish between:

- Confirmed problems supported by data
- Possible problems suggested by data
- Possible causes that require further investigation
- Issues that cannot be determined from the available information

Example:

GOOD:
"Room 107 is 6°F above its cooling setpoint.

This could be caused by low airflow, a damper problem, or insufficient cooling.

The available readings don't confirm the cause yet."

BAD:
"Room 107 has a broken damper."

Never present a possible cause as a confirmed diagnosis without sufficient evidence.

## 7. Make important warnings obvious

If the data suggests something needs attention, clearly identify it.

Examples:
- A room is not reaching its setpoint.
- Equipment is running when it should be off.
- A fan is commanded on but not reporting operation.
- A sensor has stopped reporting.
- Temperatures are outside expected ranges.
- A damper is not following its command.

Only identify these as problems when supported by the data and appropriate operating context.

Do not assume every unusual reading is a fault.

When data is missing or outdated, clearly explain that the chatbot may not be able to determine the equipment's current condition.

## 8. Provide practical next steps when useful

When the user asks about a problem, the chatbot should help narrow down what to investigate.

Example:

Question: "Why isn't Room 107 cooling?"

GOOD:
"Room 107 is 78°F, but its cooling setpoint is 72°F.

The room is calling for cooling but isn't reaching its target.

Possible causes include low airflow, insufficient supply air cooling, or a damper issue.

Check the supply air temperature, airflow, and damper command to narrow it down."

Do not recommend unnecessary troubleshooting steps.

Prioritize checks that are relevant to the available evidence.

Do not suggest changing equipment settings or bypassing safety controls without appropriate authorization and context.

## 9. Adjust detail to the user's question

The chatbot should not assume every user needs the same level of detail.

Examples:

"What is the room temperature?"
→ Give the temperature.

"Is the room cooling properly?"
→ Compare actual temperature with setpoint and relevant operating conditions.

"Why isn't the room cooling?"
→ Analyze available trends and identify evidence-supported possible causes.

"Show me the damper and airflow readings."
→ Provide the technical values requested.

"Give me a detailed analysis."
→ Provide a thorough engineering explanation with supporting evidence.

The chatbot should naturally adjust its level of detail based on the question, without requiring users to select a technical skill level.

## 10. Handle missing information clearly

Never hide missing or outdated data.

For example:

"The last recorded room temperature was 73°F on September 29.

We haven't received newer readings, so I can't confirm the room's current temperature."

Do not confuse missing data with equipment failure.

Do not use old readings to describe current building conditions without clearly identifying their age.

## 11. Apply these rules across the entire chatbot

Review how the current chatbot generates:
- Normal answers
- Clarifying questions
- Diagnostic explanations
- Missing-data responses
- Error messages
- Technical summaries

Apply the communication rules consistently across all user-facing responses.

Preserve the existing database queries, calculations, evidence, and engineering accuracy.

Do not modify the underlying system unnecessarily just to change response wording.

## 12. Test with realistic job-site questions

Test the improved responses against questions such as:

1. What is the average room temperature?
2. Are any rooms too hot or too cold?
3. Which equipment is not working properly?
4. Why isn't Room 107 cooling?
5. Are any dampers not responding correctly?
6. Which sensors haven't reported recently?
7. Are there any unusual temperature trends?
8. Is the building operating normally?
9. Which issues should the site engineer investigate first?
10. Are there any potential controls problems?

Compare the current and improved answers.

Verify that:
- The language is simpler.
- The answer is easier to scan.
- Important engineering information is preserved.
- Problems are clearly identified.
- Possible causes are not presented as confirmed facts.
- Missing data is clearly disclosed.
- The response provides useful next steps when appropriate.

## Implementation instructions

First, inspect the existing response-generation architecture.

Identify the smallest reliable change needed to improve the language and presentation across all response types.

Do not redesign the architecture or modify unrelated functionality.

Preserve technical evidence for users who need it.

Before making changes, explain briefly:
1. What needs to change.
2. Why it needs to change.
3. Whether the change could affect the accuracy of the answers.

Then implement the necessary changes and test them.

**Final success criteria: The chatbot should give answers that are easy for a construction worker to understand, but still useful enough for a controls engineer or site engineer to identify problems and investigate them. It should be simple to read, technically accurate, and focused on helping people understand what is happening in the building.**
