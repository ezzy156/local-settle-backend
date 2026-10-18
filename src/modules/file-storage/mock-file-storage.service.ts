import { Injectable } from '@nestjs/common';
import {
  FileStorageService,
  StoredFile,
  UploadFileInput,
} from './file-storage.service';

@Injectable()
export class MockFileStorageService extends FileStorageService {
  async deleteFile(_storedUrl: string): Promise<void> {
    // The mock provider does not persist uploaded objects.
  }

  uploadFile(file: UploadFileInput): Promise<StoredFile> {
    const key =
      file.key ??
      (() => {
        const safeName = file.originalname
          .toLowerCase()
          .replace(/[^a-z0-9.-]+/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '');
        const timestamp = Date.now();
        return `profile-images/${timestamp}-${safeName || 'upload'}`;
      })();

    return Promise.resolve({
      key,
      url: `https://mock-storage.ikash.local/${key}`,
    });
  }

  getSignedDownloadUrlFromUrl(url: string): Promise<string> {
    if (!url.startsWith('https://mock-storage.ikash.local/evidence/')) {
      return Promise.reject(new Error('Evidence URL is outside mock storage'));
    }
    return Promise.resolve(`${url}?expiresIn=300`);
  }

  async getSignedDownloadUrl(
    storedUrl: string,
    expiresInSeconds: number,
  ): Promise<string> {
    if (!storedUrl.startsWith('https://mock-storage.ikash.local/evidence/')) {
      throw new Error('Evidence URL is outside mock storage');
    }
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
    return `${storedUrl}?expires=${expires}&signature=mock`;
  }
}
