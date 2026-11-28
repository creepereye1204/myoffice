"""의견 첨부 요청의 크기 제한, 이미지 검증 및 재인코딩."""
import io

from fastapi import HTTPException, Request
from PIL import Image, ImageOps
from python_multipart.exceptions import MultipartParseError
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

MAX_FIELDS_BYTES = 16 * 1024
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_IMAGES = 3
MAX_PIXELS = 24_000_000
IMAGE_FORMATS = ("PNG", "JPEG", "WEBP", "GIF")


class FeedbackTooLarge(MultiPartException):
    pass


class FeedbackMultipart(MultiPartParser):
    max_part_size = MAX_FIELDS_BYTES
    complete = False

    def on_end(self):
        self.complete = True
        super().on_end()

    async def parse(self):
        try:
            return await super().parse()
        except BaseException:
            # 파서 자체 오류와 전송 중단에도 임시 파일을 닫는다.
            for file in self._files_to_close_on_error:
                file.close()
            raise


async def bounded_feedback_stream(request: Request, limit: int):
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise FeedbackTooLarge("보낼 수 있는 용량을 초과했습니다")
        yield chunk


async def read_feedback_request(request: Request):
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type == "application/json":
        payload = bytearray()
        try:
            async for chunk in bounded_feedback_stream(request, MAX_FIELDS_BYTES):
                payload.extend(chunk)
        except FeedbackTooLarge as exc:
            raise HTTPException(413, exc.message) from None
        return payload, []
    if content_type != "multipart/form-data":
        raise HTTPException(415, "JSON 또는 첨부 파일 양식으로 보내 주세요")

    parser = FeedbackMultipart(request.headers, bounded_feedback_stream(request, MAX_REQUEST_BYTES),
                               max_files=MAX_IMAGES, max_fields=1)
    try:
        form = await parser.parse()
    except FeedbackTooLarge as exc:
        raise HTTPException(413, exc.message) from None
    except (MultiPartException, MultipartParseError):
        raise HTTPException(422, "의견 양식과 이미지 개수(최대 3장)를 확인해 주세요") from None
    try:
        payload = form.get("payload")
        if not parser.complete or not isinstance(payload, str):
            raise HTTPException(422, "의견 입력 내용을 확인해 주세요")
        images = []
        for key, part in form.multi_items():
            if key == "payload":
                continue
            if key != "images" or not isinstance(part, UploadFile):
                raise HTTPException(422, "첨부 이미지를 확인해 주세요")
            if part.size is None or part.size > MAX_IMAGE_BYTES:
                raise HTTPException(413, "이미지 한 장은 5MB까지 첨부할 수 있습니다")
            images.append(await part.read())
        return payload, images
    finally:
        await form.close()


def prepare_feedback_images(images):
    prepared = []
    for data in images:
        try:
            # Pillow가 선언된 MIME 대신 파일 서명으로 형식을 판별하고 픽셀을 디코딩한다.
            with Image.open(io.BytesIO(data), formats=IMAGE_FORMATS) as source:
                if source.width * source.height > MAX_PIXELS:
                    raise HTTPException(422, "이미지 해상도가 너무 높습니다")
                source.load()
                image = ImageOps.exif_transpose(source).convert("RGBA")
                image.thumbnail((1920, 1920))
                # 첫 프레임의 픽셀만 새 이미지로 옮겨 EXIF 등 메타데이터를 제거한다.
                clean = Image.new("RGBA", image.size)
                clean.paste(image)
                encoded = io.BytesIO()
                clean.save(encoded, format="WEBP", quality=85)
        except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
            raise HTTPException(422, "PNG, JPEG, WebP 또는 GIF 이미지를 첨부해 주세요") from None
        if encoded.tell() > MAX_IMAGE_BYTES:
            raise HTTPException(413, "이미지 한 장은 5MB까지 첨부할 수 있습니다")
        prepared.append(("webp", "image/webp", encoded.getvalue()))
    return prepared
