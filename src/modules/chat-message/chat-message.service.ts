import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaginationDto } from '../../common/pagination.dto';
import { CreateChatMessageDto } from './dto/create-chat-message.dto';
import { ChatMessageRepository } from './chat-message.repository';
import { AppException, ErrorCode } from '../../common/errors';
import { ChatMessage } from '@prisma/client';
import { FileStorageService } from '../file-storage/file-storage.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditResult } from '../audit-log/enums/audit-action.enum';
import { validateChatMessageContent } from './chat-message-content';

const ALLOWED_EVIDENCE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_EVIDENCE_SIZE = 10 * 1024 * 1024;

export interface ChatAttachmentDownload {
  evidenceId: string;
  fileName: string;
  contentType: string;
  size: number;
  url: string;
  expiresInSeconds: 300;
}

@Injectable()
export class ChatMessageService {
  constructor(
    private readonly repo: ChatMessageRepository,
    private readonly fileStorage: FileStorageService,
    private readonly auditLog: AuditLogService,
  ) {}

  create(dto: CreateChatMessageDto): Promise<ChatMessage> {
    const validation = validateChatMessageContent(dto.content);
    if (!validation.valid) {
      const messages = {
        empty: 'Message cannot be empty.',
        too_long: 'Message exceeds the 4000 character limit.',
        control_character: 'Message contains unsupported control characters.',
        not_string: 'Message must be text.',
      };
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        messages[validation.reason],
      );
    }
    return this.repo.createIdempotent(
      { ...dto, content: validation.content },
    ) as Promise<ChatMessage>;
  }

  async createFromChat(input: {
    orderId: string;
    senderId: string;
    content: string;
    clientMessageId?: string;
    attachmentEvidenceIds?: string[];
  }): Promise<ChatMessage> {
    const evidenceIds = input.attachmentEvidenceIds ?? [];
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (
      evidenceIds.length > 5 ||
      new Set(evidenceIds).size !== evidenceIds.length ||
      evidenceIds.some((id) => !uuidPattern.test(id))
    ) {
      throw new BadRequestException(
        'Provide at most five unique evidence references.',
      );
    }

    let evidence: Awaited<
      ReturnType<ChatMessageRepository['findEvidenceForOrder']>
    > = [];
    if (evidenceIds.length) {
      evidence = await this.repo.findEvidenceForOrder(
        input.orderId,
        evidenceIds,
      );
      if (evidence.length !== evidenceIds.length) {
        throw new BadRequestException(
          'Evidence must exist on this order before it can be attached.',
        );
      }
      if (
        evidence.some(
          (item) =>
            !item.evidenceFileName ||
            !item.evidenceContentType ||
            !ALLOWED_EVIDENCE_TYPES.includes(item.evidenceContentType) ||
            !item.evidenceSize ||
            item.evidenceSize < 1 ||
            item.evidenceSize > MAX_EVIDENCE_SIZE,
        )
      ) {
        throw new BadRequestException(
          'Evidence metadata must be valid before it can be attached.',
        );
      }
    }

    const message = await this.repo.createIdempotent({
      orderId: input.orderId,
      senderId: input.senderId,
      content: input.content,
      clientMessageId: input.clientMessageId,
      attachmentRefs: evidenceIds,
    }) as ChatMessage;

    if (evidenceIds.length) {
      await this.auditLog.create({
        userId: input.senderId,
        action: AuditAction.CHAT_ATTACHMENT_LINKED,
        resourceType: 'ChatMessage',
        resourceId: message.messageId,
        result: AuditResult.SUCCESS,
        metadata: {
          orderId: input.orderId,
          evidenceCount: evidenceIds.length,
          attachments: evidence.map((item) => ({
            evidenceId: item.escrowId,
            contentType: item.evidenceContentType,
            size: item.evidenceSize,
          })),
        },
      });
    }
    return message;
  }

  async getSignedAttachmentsForOrder(
    orderId: string,
    userId: string,
    evidenceIds: string[],
  ): Promise<ChatAttachmentDownload[]> {
    if (!(await this.canAccessOrder(orderId, userId))) {
      throw new ForbiddenException(
        'Order membership is required to access evidence.',
      );
    }
    return this.signEvidence(orderId, evidenceIds);
  }

  async getSignedAttachmentsForMessage(
    messageId: string,
    userId: string,
  ): Promise<ChatAttachmentDownload[]> {
    const message = await this.repo.findMessageOrderAndAttachmentRefs(messageId);
    if (!message) throw new BadRequestException('Chat message not found.');
    if (!(await this.canAccessOrder(message.orderId, userId))) {
      throw new ForbiddenException(
        'Order membership is required to access evidence.',
      );
    }
    const evidenceIds = Array.isArray(message.attachmentRefs)
      ? message.attachmentRefs.filter(
          (id): id is string => typeof id === 'string',
        )
      : [];
    return this.signEvidence(message.orderId, evidenceIds);
  }

  private async signEvidence(
    orderId: string,
    evidenceIds: string[],
  ): Promise<ChatAttachmentDownload[]> {
    if (!evidenceIds.length) return [];
    const evidence = await this.repo.findEvidenceForOrder(orderId, evidenceIds);
    if (evidence.length !== evidenceIds.length) {
      throw new BadRequestException(
        'Evidence reference is no longer available on this order.',
      );
    }

    return Promise.all(
      evidence.map(
        async ({
          escrowId,
          evidenceUrl,
          evidenceFileName,
          evidenceContentType,
          evidenceSize,
        }) => {
          if (!evidenceUrl) {
            throw new BadRequestException('Evidence file is unavailable.');
          }
          if (
            !evidenceFileName ||
            !evidenceContentType ||
            !ALLOWED_EVIDENCE_TYPES.includes(evidenceContentType) ||
            !evidenceSize ||
            evidenceSize < 1 ||
            evidenceSize > MAX_EVIDENCE_SIZE
          ) {
            throw new BadRequestException('Evidence metadata is invalid.');
          }
          return {
            evidenceId: escrowId,
            fileName: evidenceFileName,
            contentType: evidenceContentType,
            size: evidenceSize,
            url: await this.fileStorage.getSignedDownloadUrlFromUrl(evidenceUrl),
            expiresInSeconds: 300 as const,
          };
        },
      ),
    );
  }

  markDelivered(orderId: string, recipientId: string) {
    return this.repo.markDelivered(orderId, recipientId);
  }

  markRead(orderId: string, readerId: string) {
    return this.repo.markRead(orderId, readerId);
  }

  async canAccessOrder(
    orderId: string,
    userId: string,
  ): Promise<boolean | null> {
    const order = await this.repo.findOrderParticipants(orderId);
    if (!order) return null;
    return order.buyerId === userId || order.sellerId === userId;
  }

  list(p: PaginationDto, orderId?: string): Promise<ChatMessage[]> {
    if (orderId) return this.listOrderHistory(orderId, p);
    return this.repo.findMany({
      skip: p.skip,
      take: p.take ?? 50,
      orderBy: { timestamp: 'desc' },
    }) as Promise<ChatMessage[]>;
  }

  async listOrderHistory(orderId: string, p: PaginationDto): Promise<ChatMessage[]> {
    if (p.cursor && !(await this.repo.cursorBelongsToOrder(orderId, p.cursor))) {
      throw new BadRequestException('Cursor must identify a message in this order');
    }
    return this.repo.findByOrder(orderId, p.skip, Math.min(p.take ?? 50, 100), p.cursor);
  }

  async assertOrderAccess(orderId: string, userId: string): Promise<void> {
    const allowed = await this.canAccessOrder(orderId, userId);
    if (allowed === null) throw new NotFoundException('Order not found');
    if (!allowed) throw new ForbiddenException('Only order participants can read chat history');
  }

  async get(id: string): Promise<ChatMessage> {
    const item = (await this.repo.findById(id)) as ChatMessage;
    if (!item) {
      throw new AppException(
        ErrorCode.CHAT_MESSAGE_NOT_FOUND,
        `Chat message ${id} not found`,
      );
    }
    return item;
  }

  remove(id: string): Promise<ChatMessage> {
    return this.repo.delete(id) as Promise<ChatMessage>;
  }
}
