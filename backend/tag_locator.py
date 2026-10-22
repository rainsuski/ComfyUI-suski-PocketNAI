from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
COMFY_ROOT = PLUGIN_ROOT.parent.parent

FALLBACK_TAGS = Path(__file__).resolve().parent / "assets" / "danbooru_min.csv"

# Community autocomplete packs use different folders depending on the
# installation. The first readable file wins, so the bundled list is only a
# last resort.
TAG_CANDIDATES = (
    "custom_nodes/ComfyUI-Custom-Scripts/user/autocomplete/danbooru.csv",
    "custom_nodes/comfyui-custom-scripts/user/autocomplete/danbooru.csv",
    "custom_nodes/ComfyUI-Custom-Scripts/web/js/assets/danbooru.csv",
    "custom_nodes/comfyui-custom-scripts/web/js/assets/danbooru.csv",
    "custom_nodes/ComfyUI_tagcomplete/tags/danbooru.csv",
    "custom_nodes/ComfyUI-Autocomplete-Aaalice/data/danbooru_tags.csv",
)


def find_tags_file() -> Path:
    for relative in TAG_CANDIDATES:
        candidate = COMFY_ROOT / relative
        if candidate.is_file() and candidate.stat().st_size > 0:
            return candidate
    return FALLBACK_TAGS
