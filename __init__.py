import logging
import sys

logger = logging.getLogger("ComfyUI-PocketNAI")


def _patch_windows_asyncio_accept():
    """修复 CPython Issue #93821:

    在 Windows ProactorEventLoop 下，当客户端（如隧道断开、手机切后台）在完成三次握手但未被 accept 前发送 RST 时，
    IOCP 会抛出 WinError 64 (ERROR_NETNAME_DELETED) 或 1236/10054。
    CPython 标准库误将此错误当作监听 Socket 损坏，直接执行 sock.close()，导致 IPv4 端口永久关闭且假死。
    此补丁拦截该临时网络异常并自动重新 accept，保证服务长存。
    """
    if sys.platform != "win32":
        return

    try:
        from asyncio.windows_events import IocpProactor

        if getattr(IocpProactor, "_pocketnai_patched", False):
            return

        old_accept = IocpProactor.accept
        TRANSIENT_WINERRORS = {
            64,  # ERROR_NETNAME_DELETED: 指定的网络名不再可用
            1236,  # ERROR_CONNECTION_ABORTED: 本地系统已终止网络连接
            10054,  # WSAECONNRESET: 远程主机强迫关闭了一个现有的连接
            1225,  # ERROR_CONNECTION_REFUSED
        }

        def safe_accept(self, listener):
            loop = self._loop
            outer = loop.create_future()
            box = {}

            def arm():
                if outer.done():
                    return
                try:
                    box["inner"] = old_accept(self, listener)
                    box["inner"].add_done_callback(done)
                except OSError as exc:
                    if (
                        getattr(exc, "winerror", None) in TRANSIENT_WINERRORS
                        and listener.fileno() != -1
                    ):
                        loop.call_soon(arm)
                    else:
                        outer.set_exception(exc)

            def done(fut):
                if outer.done():
                    return
                if fut.cancelled():
                    outer.cancel()
                    return

                exc = fut.exception()
                if exc is None:
                    outer.set_result(fut.result())
                elif (
                    isinstance(exc, OSError)
                    and getattr(exc, "winerror", None) in TRANSIENT_WINERRORS
                    and listener.fileno() != -1
                ):
                    # 客户端在 Accept 过程中提前断开，监听 Socket 依旧健康，继续等待下一连接
                    loop.call_soon(arm)
                else:
                    outer.set_exception(exc)

            outer.add_done_callback(
                lambda o: o.cancelled()
                and box.get("inner")
                and not box["inner"].done()
                and box["inner"].cancel()
            )
            arm()
            return outer

        IocpProactor.accept = safe_accept
        IocpProactor._pocketnai_patched = True
        logger.info(
            "PocketNAI 已成功加载 Windows asyncio socket 自愈补丁 (CPython #93821)"
        )
    except Exception as e:
        logger.warning(
            "PocketNAI 加载 Windows asyncio 自愈补丁失败（如非 Windows 可忽略）: %s",
            e,
        )


# 在注册任何服务或网络调用之前优先安装补丁
_patch_windows_asyncio_accept()

from .backend.routes import register_routes

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

register_routes()
logger.info("PocketNAI routes registered")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]