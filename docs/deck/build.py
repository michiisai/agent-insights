"""Build the Agent Insights final-presentation deck."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from pptx import Presentation
from pptx.util import Inches
from theme import (SLIDE_W, SLIDE_H, BLUE, MAGENTA, PURPLE, TEAL, GREEN, AMBER,
                   notes, number_pages)
import slides_a as A
import slides_b as B
import slides_c as C
import slides_d as D

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("agent-insights-final.pptx")


def main():
    prs = Presentation()
    prs.slide_width = SLIDE_W
    prs.slide_height = SLIDE_H

    core = prs.core_properties
    core.title = "Agent Insights \u2014 OpenTelemetry for AI coding agents, inside VS Code"
    core.author = "Michelle Ma"
    core.subject = "Microsoft internship final presentation"
    core.comments = ("Final presentation for the VS Code internship project Agent Insights. "
                     "Speaker notes on every slide; timings in square brackets. "
                     "Slides marked OPTIONAL in the notes are the designated cut list.")

    A.s_title(prs)          # 1
    D.s_about(prs)          # 2

    d = A.divider(prs, "01", "Problem",
                  "Agent runs are the most expensive and least observable\n"
                  "thing a developer starts all day.", color=BLUE)
    notes(d, "Name the beats: where this problem lives, what the data actually is, what you "
             "still can't answer, and why. Say: \"I want to earn the rest of the talk here.\"")
    D.s_context(prs)        # where it lives
    A.s_otel(prs)           # what the data is
    A.s_problem_user(prs)   # what you can't answer
    A.s_problem_logs(prs)   # why the existing data doesn't help
    A.s_span_vs_turn(prs)   # the crux
    D.s_goal(prs)           # what I set out to build

    d = A.divider(prs, "02", "The twist",
                  "Halfway through, VS Code shipped Agent Host \u2014 and\n"
                  "changed which problem I was solving.", color=MAGENTA)
    notes(d, "One line: \"and then, about halfway through, the platform I was "
             "building on shipped something that changed the project \u2014 and made it matter "
             "more.\" Then advance.")
    A.s_agent_host(prs)     # what it gave, what it broke
    D.s_use_cases(prs)      # and other people are feeling it too

    d = A.divider(prs, "03", "Approach",
                  "Three vocabularies in. One model out.\n"
                  "Architecture, and the normalization that is the actual contribution.",
                  color=PURPLE)
    notes(d, "Structure the section out loud: first the input \u2014 how the three "
             "harnesses actually differ \u2014 then the seven things that have to happen, the design, "
             "the hardest problem inside it, and finally the shape that comes out.")
    A.s_diff_table(prs)     # 13  the mess
    D.s_pipeline(prs)       # 14  what has to happen
    D.s_friction(prs)       # 15  every stage breaks
    B.s_architecture(prs)   # 16  the system
    B.s_norm_tokens(prs)    # 17  the contribution
    B.s_session_model(prs)  # 18  what comes out
    B.s_surfaces(prs)       # 19  how you touch it

    d = A.divider(prs, "04", "Demo",
                  "Two scenarios, both ending on the loop closing.\n"
                  "Recorded on real multi-harness data.", color=TEAL)
    notes(d, "Switch to VS Code BEFORE you finish talking. Say: \"two scenarios "
             "\u2014 the first one no existing tool can do at all, the second one looks boring and is "
             "the hardest thing I built.\"")
    C.s_demo1(prs)          # 23
    C.s_demo2(prs)          # 24

    d = A.divider(prs, "05", "Impact",
                  "What is true now that wasn\u2019t before \u2014 and where\n"
                  "it goes from here.", color=GREEN)
    notes(d, "Straight through \u2014 don't linger on the divider.")
    C.s_impact(prs)         # what is true now
    C.s_next(prs)           # where this goes

    d = A.divider(prs, "06", "Reflection",
                  "What made it hard, and what I took\n"
                  "away from it.", color=AMBER)
    notes(d, "Straight through.")
    D.s_challenges(prs)
    D.s_outcomes(prs)

    D.s_thanks_people(prs)
    D.s_close_contact(prs)

    C.s_appendix_numbers(prs)  # appendix
    C.s_appendix_setup(prs)
    C.s_scorecard(prs)
    D.s_appendix_dataflow(prs)
    B.s_storage(prs)
    B.s_norm_identity(prs)
    B.s_norm_transcripts(prs)
    C.s_appendix_hard(prs)
    C.s_learn1(prs)
    C.s_learn2(prs)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    number_pages(prs)
    prs.save(str(OUT))
    print("wrote %s  (%d slides)" % (OUT, len(prs.slides._sldIdLst)))


if __name__ == "__main__":
    main()
