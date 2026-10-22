import logging

from .backend.routes import register_routes

logger = logging.getLogger("ComfyUI-suski-PocketNAI")

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

register_routes()
logger.info("PocketNAI routes registered")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
