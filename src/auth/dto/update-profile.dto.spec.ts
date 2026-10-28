import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateProfileDto } from './update-profile.dto';

describe('UpdateProfileDto', () => {
  it.each(['Europe/Kyiv', 'America/New_York', 'Asia/Tokyo'])(
    'accepts the valid IANA timezone %s',
    async (timezone) => {
      await expect(
        validate(plainToInstance(UpdateProfileDto, { timezone })),
      ).resolves.toHaveLength(0);
    },
  );

  it('rejects an invalid timezone', async () => {
    const errors = await validate(
      plainToInstance(UpdateProfileDto, { timezone: 'Not/A_Timezone' }),
    );

    expect(errors).not.toHaveLength(0);
  });

  it.each([{}, { timezone: null }])(
    'keeps missing or null timezone backward compatible: %p',
    async (input) => {
      await expect(
        validate(plainToInstance(UpdateProfileDto, input)),
      ).resolves.toHaveLength(0);
    },
  );
});
