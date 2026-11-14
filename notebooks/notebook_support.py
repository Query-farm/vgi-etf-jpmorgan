"""Presentation helpers for the reported maturity-window example."""

from pathlib import Path

import matplotlib.pyplot as plt
import seaborn as sns
from IPython.display import Markdown, display

COLORS = {0: "#b05b60", 1: "#27765d", 2: "#557ca6", 3: "#ad8b48"}


def theme() -> None:
    """Apply readable shared chart settings."""
    sns.set_theme(style="whitegrid", context="notebook", font="DejaVu Sans")
    plt.rcParams.update(
        {"figure.dpi": 130, "text.parse_math": False, "axes.spines.top": False, "axes.spines.right": False}
    )


def prose(text: str) -> None:
    """Display result-derived Markdown."""
    display(Markdown(text))


def finish(fig: plt.Figure, title: str, subtitle: str, filename: str) -> None:
    """Add source context and save the chart for review."""
    fig.suptitle(title, x=0.07, y=0.98, ha="left", fontsize=16, weight="bold", color="#253d31")
    fig.text(0.07, 0.925, subtitle, fontsize=10.5, color="#52675a")
    fig.text(
        0.07,
        0.025,
        "Source: J.P. Morgan current product-data · real vgi-etf-jpmorgan v0.4.0 through Haybarn / VGI\n"
        "Reported maturity dates: final legal maturity, falling back to WAM maturity · "
        "not duration or forecast repayments",
        fontsize=9,
        color="#52675a",
    )
    directory = Path("validation/charts")
    directory.mkdir(parents=True, exist_ok=True)
    fig.savefig(directory / filename, dpi=150)
    plt.show()
